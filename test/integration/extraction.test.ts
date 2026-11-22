import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { ManagedTransaction } from "neo4j-driver";
import { freshDatabase, closeDatabase, expireLease, type TestContext } from "./helpers.js";
import { newSession } from "../../src/interfaces/neo4j.js";
import { FencingError } from "../../src/core/errors.js";
import { JobLedger } from "../../src/jobs/ledger.js";
import { JobWorker } from "../../src/jobs/worker.js";
import { EpisodeStore } from "../../src/memory/episodeStore.js";
import { Neo4jEpisodeReader } from "../../src/memory/episodeReader.js";
import { Neo4jStatementStore } from "../../src/memory/statementStore.js";
import { ExtractionService } from "../../src/extraction/extractEpisode.js";
import { ExtractionJobHandler } from "../../src/extraction/extractionJobHandler.js";
import { EXTRACTION_PROMPT_HASH } from "../../src/extraction/prompt.js";
import { FakeLLMProvider } from "../../src/fakes/providers.js";

/**
 * Slice 3 end-to-end against real Neo4j: episode -> fenced extract job ->
 * validated candidates -> append-only Statement/Evidence/Entity graph.
 *
 * Requires Docker (`npm run test:integration`). Nothing here runs without it.
 *
 * Provider is the deterministic in-memory fake, so these tests verify
 * persistence, fencing, provenance and idempotency — NOT semantic quality.
 */

let ctx: TestContext;

const AT = "2026-11-16T09:00:00.000Z";

before(async () => {
  ctx = await freshDatabase();
});

after(async () => {
  await closeDatabase(ctx);
});

// ---------------------------------------------------------------- helpers

async function createEpisode(id: string, text: string): Promise<void> {
  const s = newSession(ctx.driver, "WRITE");
  try {
    await s.run(
      `CREATE (e:Episode {
         id: $id, externalId: $externalId, sessionId: 'sess-extract', seq: 0,
         role: 'user', text: $text, occurredAt: datetime($at),
         precision: 'second', tz: 'UTC', source: 'chat', createdAt: datetime($at)
       })`,
      { id, externalId: `ext-${id}`, text, at: AT },
    );
  } finally {
    await s.close();
  }
}

async function count(cypher: string, params: Record<string, unknown> = {}): Promise<number> {
  const s = newSession(ctx.driver, "READ");
  try {
    const { records } = await s.run(cypher, params);
    return records[0]?.get("n") as number;
  } finally {
    await s.close();
  }
}

/** Every statement asserted by one episode, joined to its evidence span. */
async function statementsFor(episodeId: string): Promise<Record<string, any>[]> {
  const s = newSession(ctx.driver, "READ");
  try {
    const { records } = await s.run(
      `MATCH (ep:Episode {id: $id})-[:ASSERTS]->(st:Statement)
       OPTIONAL MATCH (st)-[:SUPPORTED_BY]->(ev:Evidence)
       RETURN st AS s, ev AS e ORDER BY st.id`,
      { id: episodeId },
    );
    return records.map((r) => ({
      ...r.get("s").properties,
      evidence: r.get("e") === null ? null : r.get("e").properties,
    }));
  } finally {
    await s.close();
  }
}

async function jobById(jobId: string): Promise<Record<string, any>> {
  const s = newSession(ctx.driver, "READ");
  try {
    const { records } = await s.run("MATCH (j:Job {id: $id}) RETURN j", { id: jobId });
    assert.equal(records.length, 1, `job ${jobId} must exist`);
    return records[0]!.get("j").properties;
  } finally {
    await s.close();
  }
}

const candidateFor = (text: string, over: Record<string, unknown> = {}) => ({
  subject: { name: "We" },
  predicate: "should use",
  object: { kind: "entity", name: "Postgres", type: "product" },
  polarity: "positive",
  modality: "proposed",
  decisionStatus: "proposed",
  confidence: 0.8,
  evidence: { quote: text, spanStart: 0, spanEnd: text.length },
  ...over,
});

const providerFor = (candidates: unknown[], model = "fake-llm-1") =>
  new FakeLLMProvider(
    () => ({
      text: JSON.stringify({ candidates }),
      model,
      usage: { inputTokens: 100, outputTokens: 50 },
      finishReason: "stop",
    }),
    model,
  );

interface Fixture {
  ledger: JobLedger;
  worker: JobWorker<ManagedTransaction>;
  handler: ExtractionJobHandler<ManagedTransaction>;
  statements: Neo4jStatementStore;
}

function build(provider: FakeLLMProvider, workerId = "w-extract"): Fixture {
  const statements = new Neo4jStatementStore(ctx.driver);
  const extractor = new ExtractionService({ provider, timeoutMs: 0, maxProviderAttempts: 2 });
  const handler = new ExtractionJobHandler<ManagedTransaction>({
    episodes: new Neo4jEpisodeReader(new EpisodeStore(ctx.driver)),
    extractor,
    statements,
  });
  const ledger = new JobLedger(ctx.driver, { leaseSeconds: 120, sweepIntervalMs: 30_000 });
  const worker = new JobWorker<ManagedTransaction>(ledger, [handler], {
    workerId,
    leaseRenewMs: 0,
    idleDelayMs: 0,
  });
  return { ledger, worker, handler, statements };
}

// ---------------------------------------------------------------- tests

test("an extract job persists validated statements with exact spans and full provenance", async () => {
  const text = "We should use Postgres for the new service.";
  await createEpisode("ep-int-basic", text);

  const { ledger, worker, statements } = build(providerFor([candidateFor(text)]));
  const jobId = await ledger.enqueue("extract", { episodeId: "ep-int-basic" }, "int:basic", { maxAttempts: 1 });

  assert.equal(await worker.runOnce(), "completed");

  const rows = await statementsFor("ep-int-basic");
  assert.equal(rows.length, 1);
  const row = rows[0]!;

  // Exact span, not a paraphrase: the quote must be the episode's own bytes.
  assert.equal(row.evidence.quote, text);
  assert.equal(text.slice(row.evidence.spanStart, row.evidence.spanEnd), row.evidence.quote);
  assert.equal(row.evidence.episodeId, "ep-int-basic");
  assert.equal(row.evidence.kind, "episode_span");
  assert.equal(row.evidence.messageExternalId, "ext-ep-int-basic");

  // Epistemic status derives from the episode role, never from the model's claim.
  assert.equal(row.modality, "proposed");
  assert.equal(row.assertedBy, "user");
  assert.equal(row.epistemicStatus, "user_asserted");

  // Extractor/model/prompt provenance is on the statement itself.
  assert.equal(row.extractionModel, "fake-llm-1");
  assert.equal(row.extractionPromptHash, EXTRACTION_PROMPT_HASH);
  const qualifier = JSON.parse(row.predicateQualifierJson);
  assert.equal(qualifier.extractionStatus, "accepted");
  assert.ok(qualifier.extractionSchema.startsWith("candidate/"));

  // The statement is readable back through the port, not just raw Cypher.
  const viaStore = await statements.byId(row.id);
  assert.ok(viaStore);
  assert.equal(viaStore!.predicate, "should_use");
  assert.equal(viaStore!.extractionModel, "fake-llm-1");

  // Mention-scoped entities: subject and object, no merging (Slice 4 owns that).
  const entityCount = await count(
    `MATCH (s:Statement {id: $id})-[:SUBJECT|OBJECT]->(e:Entity) RETURN count(e) AS n`,
    { id: row.id },
  );
  assert.equal(entityCount, 2);

  const job = await jobById(jobId);
  assert.equal(job.status, "completed");
  assert.equal(job.lastError, null);
});

test("reprocessing the same episode is idempotent: no duplicate statements or evidence", async () => {
  const text = "We should use Postgres for the new service.";
  const { ledger, worker } = build(providerFor([candidateFor(text)]));

  const rerunId = await ledger.enqueue("extract", { episodeId: "ep-int-basic" }, "int:basic-rerun", { maxAttempts: 1 });
  assert.equal(await worker.runOnce(), "completed");

  const rows = await statementsFor("ep-int-basic");
  assert.equal(rows.length, 1, "a second extraction must merge into the same statement id");
  assert.equal(
    await count(`MATCH (e:Evidence) WHERE e.episodeId = 'ep-int-basic' RETURN count(e) AS n`),
    1,
    "evidence must not duplicate either",
  );
  assert.equal((await jobById(rerunId)).status, "completed");
});

test("a changed extractor model is stored alongside, never as an overwrite", async () => {
  const text = "We should use Postgres for the new service.";
  await createEpisode("ep-int-versioned", text);

  const a = build(providerFor([candidateFor(text)], "model-a"));
  await a.ledger.enqueue("extract", { episodeId: "ep-int-versioned" }, "int:ver-a", { maxAttempts: 1 });
  assert.equal(await a.worker.runOnce(), "completed");
  const first = await statementsFor("ep-int-versioned");
  assert.equal(first.length, 1);
  assert.equal(first[0]!.extractionModel, "model-a");

  const b = build(providerFor([candidateFor(text)], "model-b"));
  await b.ledger.enqueue("extract", { episodeId: "ep-int-versioned" }, "int:ver-b", { maxAttempts: 1 });
  assert.equal(await b.worker.runOnce(), "completed");

  const second = await statementsFor("ep-int-versioned");
  assert.equal(second.length, 2, "a new extractor version is distinguishable, not silently replaced");
  const models = second.map((r) => r.extractionModel).sort();
  assert.deepEqual(models, ["model-a", "model-b"]);
  assert.notEqual(first[0]!.id, second.find((r) => r.extractionModel === "model-b")!.id);
});

test("a fenced-out worker's prepared extraction output commits nothing", async () => {
  const text = "We should use Postgres for the new service.";
  await createEpisode("ep-int-stale", text);

  const { ledger, handler } = build(providerFor([candidateFor(text)]), "w-stale");
  const jobId = await ledger.enqueue("extract", { episodeId: "ep-int-stale" }, "int:stale", { maxAttempts: 1 });

  // The stale worker claims and prepares — the provider call happens OUTSIDE the fence.
  const claimed = await ledger.claimNext("w-stale");
  assert.ok(claimed);
  assert.equal(claimed!.id, jobId);
  const prepared = await handler.prepare(claimed!);
  assert.equal(prepared.summary, "1 candidate(s) accepted");
  assert.equal(
    await count(`MATCH (ep:Episode {id: 'ep-int-stale'})-[:ASSERTS]->(s) RETURN count(s) AS n`),
    0,
    "preparation alone must not persist anything",
  );

  // Its lease lapses and another worker takes the job over.
  await expireLease(ctx, jobId);
  await ledger.sweep();
  const reclaimed = await ledger.claimNext("w-fresh");
  assert.ok(reclaimed, "the expired job must be reclaimable");
  assert.ok(reclaimed!.claimGeneration > claimed!.claimGeneration);

  // The stale worker's fenced commit is rejected by the real Neo4j ledger.
  await assert.rejects(
    ledger.commitFencedOutput(claimed!.id, claimed!.claimGeneration, "w-stale", (tx) =>
      prepared.commit(tx),
    ),
    (err: unknown) => err instanceof FencingError,
  );
  assert.equal(
    await count(`MATCH (ep:Episode {id: 'ep-int-stale'})-[:ASSERTS]->(s) RETURN count(s) AS n`),
    0,
    "stale output must leave zero statements behind",
  );

  // And it cannot mark its own job done either.
  assert.equal(await ledger.complete(claimed!.id, claimed!.claimGeneration, "w-stale"), false);
});

test("one invalid candidate fails the job and persists nothing (all-or-nothing)", async () => {
  const text = "We should use Postgres for the new service.";
  await createEpisode("ep-int-invalid", text);

  const bad = candidateFor(text, { subject: { name: "MongoDB" } });
  const { ledger, worker } = build(providerFor([candidateFor(text), bad]));
  const jobId = await ledger.enqueue("extract", { episodeId: "ep-int-invalid" }, "int:invalid", { maxAttempts: 1 });

  assert.equal(await worker.runOnce(), "dead", "maxAttempts: 1 exhausts immediately");

  const job = await jobById(jobId);
  assert.equal(job.status, "dead");
  assert.ok(job.lastError.includes("extraction rejected: 1 of 2 candidate(s) failed validation"));
  assert.ok(job.lastError.includes("no statements will be persisted"));
  assert.ok(job.lastError.includes("does not appear in the source episode"));
  assert.equal(
    await count(`MATCH (ep:Episode {id: 'ep-int-invalid'})-[:ASSERTS]->(s) RETURN count(s) AS n`),
    0,
    "the valid half of the result must be discarded too",
  );
});

test("negation and modality survive persistence byte-for-byte", async () => {
  const text = "We must not use MongoDB for the core database.";
  await createEpisode("ep-int-negation", text);

  const negative = {
    subject: { name: "We" },
    predicate: "must not use",
    object: { kind: "entity", name: "MongoDB", type: "product" },
    polarity: "negative",
    modality: "asserted",
    category: "constraint",
    confidence: 0.9,
    evidence: { quote: text, spanStart: 0, spanEnd: text.length },
  };
  const { ledger, worker } = build(providerFor([negative]));
  await ledger.enqueue("extract", { episodeId: "ep-int-negation" }, "int:negation", { maxAttempts: 1 });
  assert.equal(await worker.runOnce(), "completed");

  const rows = await statementsFor("ep-int-negation");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.polarity, "negative", "a prohibition must not round-trip as a positive fact");
  assert.equal(rows[0]!.modality, "asserted");
  const qualifier = JSON.parse(rows[0]!.predicateQualifierJson);
  assert.equal(qualifier.predicateText, "must not use");
});

test("a question stays a question instead of becoming an asserted fact", async () => {
  const text = "Should we use Redis for caching?";
  await createEpisode("ep-int-question", text);

  const questioned = {
    subject: { name: "we" },
    predicate: "asked_about",
    object: { kind: "entity", name: "Redis", type: "product" },
    polarity: "positive",
    modality: "questioned",
    category: "question",
    confidence: 0.7,
    evidence: { quote: text, spanStart: 0, spanEnd: text.length },
  };
  const { ledger, worker } = build(providerFor([questioned]));
  await ledger.enqueue("extract", { episodeId: "ep-int-question" }, "int:question", { maxAttempts: 1 });
  assert.equal(await worker.runOnce(), "completed");

  const rows = await statementsFor("ep-int-question");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.modality, "questioned");
  assert.equal(rows[0]!.epistemicStatus, "user_asserted");
});

test("activeAt filters persisted statements on valid time and recorded time", async () => {
  const text = "We shortlisted Attio in November 2026 for the sales team.";
  await createEpisode("ep-int-temporal", text);

  const temporal = {
    subject: { name: "We" },
    predicate: "shortlisted",
    object: { kind: "entity", name: "Attio", type: "product" },
    polarity: "positive",
    modality: "shortlisted",
    decisionStatus: "proposed",
    confidence: 0.85,
    temporal: {
      expression: "November 2026",
      validFrom: "2026-11-01T00:00:00.000Z",
      timePrecision: "month",
      validity: "open_ended",
    },
    evidence: { quote: text, spanStart: 0, spanEnd: text.length },
  };
  const { ledger, worker, statements } = build(providerFor([temporal]));
  await ledger.enqueue("extract", { episodeId: "ep-int-temporal" }, "int:temporal", { maxAttempts: 1 });
  assert.equal(await worker.runOnce(), "completed");

  const rows = await statementsFor("ep-int-temporal");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.validFrom, "2026-11-01T00:00:00.000Z");

  const before = await statements.activeAt({ asOfValid: new Date("2026-10-31T00:00:00.000Z") });
  assert.equal(before.filter((s) => s.id === rows[0]!.id).length, 0, "not yet valid in October");

  const during = await statements.activeAt({ asOfValid: new Date("2026-11-15T00:00:00.000Z") });
  assert.equal(during.filter((s) => s.id === rows[0]!.id).length, 1, "valid in November");

  const recorded = await statements.activeAt({ asOfTx: new Date("2026-11-19T00:00:00.000Z") });
  assert.equal(recorded.filter((s) => s.id === rows[0]!.id).length, 1, "recorded before the as-of");
});

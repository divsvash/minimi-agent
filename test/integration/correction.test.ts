import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { ManagedTransaction } from "neo4j-driver";
import { freshDatabase, closeDatabase, expireLease, type TestContext } from "./helpers.js";
import { newSession } from "../../src/interfaces/neo4j.js";
import { FencingError } from "../../src/core/errors.js";
import { JobLedger } from "../../src/jobs/ledger.js";
import { JobWorker } from "../../src/jobs/worker.js";
import { Neo4jStatementStore } from "../../src/memory/statementStore.js";
import { Neo4jLifecycleStore } from "../../src/memory/lifecycleStore.js";
import { statementContentHash } from "../../src/memory/statementContent.js";
import { CorrectionJobHandler } from "../../src/temporal/correctionJobHandler.js";
import { CorrectionService } from "../../src/temporal/correctionService.js";
import type { StatementWrite } from "../../src/contracts/ports.js";
import type { Statement } from "../../src/contracts/schemas.js";

/** Slice 5 persistence/fencing tests against real Neo4j. NOT run without approval. */

let ctx: TestContext;
const AT = "2026-11-20T00:00:00.000Z";

before(async () => { ctx = await freshDatabase(); });
after(async () => { await closeDatabase(ctx); });

async function count(cypher: string, params: Record<string, unknown> = {}): Promise<number> {
  const s = newSession(ctx.driver, "READ");
  try {
    const { records } = await s.run(cypher, params);
    return Number(records[0]?.get("n") ?? 0);
  } finally {
    await s.close();
  }
}

async function seedEpisode(id: string): Promise<void> {
  const s = newSession(ctx.driver, "WRITE");
  try {
    await s.run(
      `CREATE (e:Episode {
         id: $id, externalId: $externalId, sessionId: 'sess-temporal', seq: 0,
         role: 'user', text: 'quoted evidence', occurredAt: datetime($at),
         precision: 'day', tz: 'UTC', source: 'chat', createdAt: datetime($at)
       })`,
      { id, externalId: `ext-${id}`, at: AT },
    );
  } finally {
    await s.close();
  }
}

const write = (id: string, recordedAt: string, over: Partial<Omit<Statement, "status">> = {}): StatementWrite => ({
  statement: {
    id,
    subjectId: "ent:subj",
    predicate: "considering",
    objectKind: "literal",
    objectValue: "Attio",
    polarity: "positive",
    modality: "asserted",
    assertedBy: "user",
    epistemicStatus: "user_asserted",
    confidence: 0.8,
    validFrom: recordedAt,
    validTo: null,
    timePrecision: "day",
    validity: "open_ended",
    recordedAt,
    ...over,
  },
  evidence: [{
    id: `ev:${id}`, kind: "episode_span", episodeId: `ep-${id}`,
    messageExternalId: `ext-ep-${id}`, spanStart: 0, spanEnd: 9, quote: "quoted ev",
  }],
  entities: [{
    id: "ent:subj", type: "concept", canonicalName: "Subject", aliases: [],
    status: "active", createdAt: recordedAt, updatedAt: recordedAt,
  }],
});

async function persist(w: StatementWrite): Promise<void> {
  const statements = new Neo4jStatementStore(ctx.driver);
  await seedEpisode(w.evidence[0]!.episodeId!);
  const session = newSession(ctx.driver, "WRITE");
  try {
    await session.executeWrite((tx) => statements.insert(tx as ManagedTransaction, w));
  } finally {
    await session.close();
  }
}

function fixture() {
  const statements = new Neo4jStatementStore(ctx.driver);
  const lifecycle = new Neo4jLifecycleStore(ctx.driver);
  const service = new CorrectionService(statements, lifecycle);
  const ledger = new JobLedger(ctx.driver, { leaseSeconds: 120, sweepIntervalMs: 30_000 });
  const worker = new JobWorker<ManagedTransaction>(ledger, [new CorrectionJobHandler(service)], {
    workerId: "w-correct", leaseRenewMs: 0, idleDelayMs: 0,
  });
  return { statements, lifecycle, service, ledger, worker };
}

test("a correction persists an append-only event and a SUPERSEDES edge", async () => {
  await persist(write("st-original", "2026-11-03T00:00:00.000Z"));
  const statements = new Neo4jStatementStore(ctx.driver);
  const fingerprint = statementContentHash((await statements.byId("st-original"))!);
  const plan = {
    kind: "supersede" as const,
    targetId: "st-original",
    expectedFingerprint: fingerprint,
    replacement: write("st-new", AT, { predicate: "selected", objectValue: "HubSpot" }),
    reason: "decision changed",
    actor: "user",
  };
  const { statements: store, ledger, worker } = fixture();
  await ledger.enqueue("correct", { plan }, "int:correct-supersede", { maxAttempts: 1 });
  assert.equal(await worker.runOnce(), "completed");

  assert.equal(await count("MATCH (e:LifecycleEvent) RETURN count(e) AS n"), 1);
  assert.equal(
    await count("MATCH (:Statement {id:'st-new'})-[:SUPERSEDES]->(:Statement {id:'st-original'}) RETURN count(*) AS n"),
    1,
  );
  assert.equal(await count("MATCH (:Statement {id:'st-original'}) RETURN count(*) AS n"), 1, "original survives");
  assert.deepEqual((await store.activeAt({})).map((s) => s.id), ["st-new"]);
  assert.deepEqual(
    (await store.activeAt({ asOfTx: new Date("2026-11-10T00:00:00.000Z") })).map((s) => s.id),
    ["st-original"],
    "historical query sees the earlier belief",
  );
});

test("a stale worker cannot commit lifecycle output", async () => {
  await persist(write("st-stale", "2026-11-03T00:00:00.000Z"));
  const statements = new Neo4jStatementStore(ctx.driver);
  const fingerprint = statementContentHash((await statements.byId("st-stale"))!);
  const plan = {
    kind: "retract" as const, targetId: "st-stale", expectedFingerprint: fingerprint,
    reason: "unsupported", actor: "user",
  };
  const { ledger, service, lifecycle } = fixture();
  const jobId = await ledger.enqueue("correct", { plan }, "int:correct-stale", { maxAttempts: 1 });
  const claimed = (await ledger.claimNext("w-stale"))!;
  assert.equal(claimed.id, jobId);
  const prepared = await new CorrectionJobHandler(service).prepare(claimed);
  await expireLease(ctx, jobId);
  await ledger.sweep();
  await assert.rejects(
    ledger.commitFencedOutput(claimed.id, claimed.claimGeneration, "w-stale", (tx) => prepared.commit(tx)),
    (err: unknown) => err instanceof FencingError,
  );
  assert.equal((await lifecycle.events()).length, 0);
  assert.equal(await count("MATCH (:Statement {id:'st-stale'}) RETURN count(*) AS n"), 1);
});

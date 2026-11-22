import { test } from "node:test";
import assert from "node:assert/strict";
import { ConflictError, ValidationError } from "../core/errors.js";
import type { Entity, Episode, Evidence, Statement } from "../contracts/schemas.js";
import type { StatementWrite } from "../contracts/ports.js";
import { fixedClock } from "../core/clock.js";
import { ExtractionService } from "../extraction/extractEpisode.js";
import { FakeLLMProvider } from "./providers.js";
import { InMemoryStatementStore } from "./memoryStatementStore.js";
import { InMemoryJobLedger } from "./memoryJobLedger.js";

const AT = "2026-11-19T00:00:00.000Z";

const entity = (id: string, name = id): Entity => ({
  id,
  type: "product",
  canonicalName: name,
  aliases: [],
  status: "active",
  createdAt: AT,
  updatedAt: AT,
});

const evidence = (over: Partial<Evidence> = {}): Evidence => ({
  id: "ev:1",
  kind: "episode_span",
  episodeId: "ep-1",
  messageExternalId: "ext-1",
  spanStart: 0,
  spanEnd: 22,
  quote: "We should use Postgres",
  ...over,
});

const statement = (over: Partial<Omit<Statement, "status">> = {}): Omit<Statement, "status"> => ({
  id: "stmt:1",
  subjectId: "ent:subj",
  predicate: "should_use",
  objectKind: "entity",
  objectId: "ent:obj",
  polarity: "positive",
  modality: "proposed",
  assertedBy: "user",
  epistemicStatus: "user_asserted",
  confidence: 0.9,
  validFrom: null,
  validTo: null,
  timePrecision: "unknown",
  validity: "open_ended",
  recordedAt: AT,
  ...over,
});

const write = (over: Partial<StatementWrite> = {}): StatementWrite => ({
  statement: statement(),
  evidence: [evidence()],
  entities: [entity("ent:subj"), entity("ent:obj")],
  ...over,
});

test("insert is idempotent for identical content and conflicts on changed content", async () => {
  const store = new InMemoryStatementStore();
  const first = await store.insert({}, write());
  assert.equal(first.id, "stmt:1");
  assert.equal(first.status, "active");
  assert.equal(store.size, 1);

  const again = await store.insert({}, write());
  assert.equal(again.id, "stmt:1", "a retry must return the existing statement");
  assert.equal(store.size, 1, "a retry must not create a second statement");

  await assert.rejects(
    () => store.insert({}, write({ statement: statement({ predicate: "must_not_use" }) })),
    (err: unknown) => err instanceof ConflictError && err.message.includes("different immutable content"),
    "the same id with different immutable content is a conflict, never an overwrite",
  );
  assert.equal(store.size, 1);
  assert.equal((await store.byId("stmt:1"))!.predicate, "should_use", "existing content is never mutated");
});

test("writes without evidence, with mixed-episode evidence, or without their entities are rejected", async () => {
  const store = new InMemoryStatementStore();

  await assert.rejects(
    () => store.insert({}, write({ evidence: [] })),
    (err: unknown) => err instanceof ValidationError && err.message.includes("at least one evidence span"),
  );
  await assert.rejects(
    () => store.insert({}, write({ evidence: [evidence(), evidence({ id: "ev:2", episodeId: "ep-2" })] })),
    (err: unknown) => err instanceof ValidationError && err.message.includes("same episode"),
  );
  await assert.rejects(
    () => store.insert({}, write({ entities: [entity("ent:obj")] })),
    (err: unknown) => err instanceof ValidationError && err.message.includes("missing its subject entity"),
  );
  await assert.rejects(
    () => store.insert({}, write({ entities: [entity("ent:subj")] })),
    (err: unknown) => err instanceof ValidationError && err.message.includes("missing its object entity"),
  );
  assert.equal(store.size, 0, "no invalid write may leave a partial statement behind");
});

test("provenance is queryable: evidence and entities are linked to their statement", async () => {
  const store = new InMemoryStatementStore();
  await store.insert({}, write());

  const evs = store.evidenceFor("stmt:1");
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.id, "ev:1");
  assert.equal(evs[0]!.episodeId, "ep-1");

  const ents = store.entitiesFor("stmt:1").map((e) => e.id).sort();
  assert.deepEqual(ents, ["ent:obj", "ent:subj"]);
  assert.deepEqual(store.evidenceFor("nope"), []);
  assert.deepEqual(store.entitiesFor("nope"), []);

  assert.equal(store.allEvidence().length, 1);
  assert.equal(store.allEntities().length, 2);
  assert.equal(store.allStatements().length, 1);
});

test("returned values are copies, so callers cannot mutate the store", async () => {
  const store = new InMemoryStatementStore();
  await store.insert({}, write());

  const s = (await store.byId("stmt:1"))!;
  s.predicate = "hacked";
  assert.equal((await store.byId("stmt:1"))!.predicate, "should_use");

  store.evidenceFor("stmt:1")[0]!.quote = "hacked";
  assert.equal(store.evidenceFor("stmt:1")[0]!.quote, "We should use Postgres");
});

test("activeAt implements the conservative valid-time and recorded-time subset", async () => {
  const store = new InMemoryStatementStore();
  await store.insert({}, write({
    statement: statement({
      id: "stmt:bounded",
      predicate: "was_bounded",
      validFrom: "2026-11-01T00:00:00.000Z",
      validTo: "2026-11-10T00:00:00.000Z",
      timePrecision: "day",
      validity: "bounded",
      recordedAt: "2026-11-05T00:00:00.000Z",
    }),
    evidence: [evidence({ id: "ev:b", spanStart: 0, spanEnd: 5, quote: "hello" })],
  }));
  await store.insert({}, write({
    statement: statement({
      id: "stmt:open",
      predicate: "is_open",
      validFrom: "2026-11-20T00:00:00.000Z",
      timePrecision: "day",
      validity: "ongoing",
      recordedAt: "2026-11-21T00:00:00.000Z",
    }),
    evidence: [evidence({ id: "ev:o", spanStart: 0, spanEnd: 5, quote: "hello" })],
  }));

  const at = (filter: Parameters<InMemoryStatementStore["activeAt"]>[0]) =>
    store.activeAt(filter).then((rows) => rows.map((r) => r.id).sort());

  // Valid time: only the bounded interval contains 2026-11-05.
  assert.deepEqual(await at({ asOfValid: new Date("2026-11-05T12:00:00.000Z") }), ["stmt:bounded"]);
  assert.deepEqual(await at({ asOfValid: new Date("2026-11-15T12:00:00.000Z") }), []);
  assert.deepEqual(await at({ asOfValid: new Date("2026-11-25T12:00:00.000Z") }), ["stmt:open"]);

  // Transaction time: only the first statement was recorded by 2026-11-06.
  assert.deepEqual(await at({ asOfTx: new Date("2026-11-06T00:00:00.000Z") }), ["stmt:bounded"]);

  // Explicit axes compose, and omitted axes are unconstrained.
  assert.deepEqual(await at({}), ["stmt:bounded", "stmt:open"]);
  assert.deepEqual(await at({ predicate: "is_open" }), ["stmt:open"]);
  assert.deepEqual(await at({ modality: "proposed", subjectId: "ent:subj" }), ["stmt:bounded", "stmt:open"]);
  assert.deepEqual(await at({ predicate: "nothing_here" }), []);
});

test("clear resets every index", async () => {
  const store = new InMemoryStatementStore();
  await store.insert({}, write());
  assert.equal(store.size, 1);
  store.clear();
  assert.equal(store.size, 0);
  assert.deepEqual(store.allEvidence(), []);
  assert.deepEqual(store.allEntities(), []);
  assert.equal(await store.byId("stmt:1"), null);
  assert.deepEqual(await store.forSubject("ent:subj"), []);
});

test("a fenced offline commit applies all staged inserts atomically", async () => {
  const store = new InMemoryStatementStore();
  const ledger = new InMemoryJobLedger();
  ledger.enqueue("extract", {}, "rollback:commit");
  const claimed = (await ledger.claimNext("w1"))!;

  await ledger.commitFencedOutput(claimed.id, claimed.claimGeneration, "w1", async (tx) => {
    await store.insert(tx, write());
    await store.insert(tx, write({
      statement: statement({ id: "stmt:2" }),
      evidence: [evidence({ id: "ev:2" })],
      entities: [entity("ent:subj"), entity("ent:obj")],
    }));
    assert.equal(store.size, 0, "staged writes are invisible until the transaction commits");
  });

  assert.deepEqual(store.allStatements().map((s) => s.id).sort(), ["stmt:1", "stmt:2"]);
  assert.deepEqual(store.allEvidence().map((e) => e.id).sort(), ["ev:1", "ev:2"]);
  assert.deepEqual(store.allEntities().map((e) => e.id).sort(), ["ent:obj", "ent:subj"]);
});

test("a failed second write rolls back the first: zero statements, evidence and entities", async () => {
  const store = new InMemoryStatementStore();
  const ledger = new InMemoryJobLedger();
  ledger.enqueue("extract", {}, "rollback:fail");
  const claimed = (await ledger.claimNext("w1"))!;

  await assert.rejects(
    () => ledger.commitFencedOutput(claimed.id, claimed.claimGeneration, "w1", async (tx) => {
      await store.insert(tx, write());
      await store.insert(tx, write({ statement: statement({ id: "stmt:1", predicate: "must_not_use" }) }));
    }),
    (err: unknown) => err instanceof ConflictError,
    "the second insert conflicts with the first staged write",
  );

  assert.deepEqual(store.allStatements(), []);
  assert.deepEqual(store.allEvidence(), []);
  assert.deepEqual(store.allEntities(), []);
  assert.equal(store.size, 0);
  assert.deepEqual(store.evidenceFor("stmt:1"), []);
  assert.deepEqual(store.entitiesFor("stmt:1"), []);
});

test("re-extracting one episode under a different clock is idempotent offline", async () => {
  const text = "We should use Postgres for the new service.";
  const ep: Episode = {
    id: "ep-clock", externalId: "ext-clock", sessionId: "sess-clock", seq: 0,
    role: "user", text, occurredAt: "2026-11-16T09:00:00.000Z",
    precision: "second", tz: "UTC", source: "chat", createdAt: "2026-11-16T09:00:00.000Z",
  };
  const candidate = {
    subject: { name: "We" },
    predicate: "should use",
    object: { kind: "entity", name: "Postgres", type: "product" },
    polarity: "positive",
    modality: "proposed",
    decisionStatus: "proposed",
    confidence: 0.8,
    evidence: { quote: text, spanStart: 0, spanEnd: text.length },
  };
  const provider = new FakeLLMProvider(() => ({
    text: JSON.stringify({ candidates: [candidate] }),
    model: "fake-llm-1",
    usage: { inputTokens: 10, outputTokens: 5 },
    finishReason: "stop",
  }));
  const extractAt = (iso: string) => new ExtractionService({
    provider, clock: fixedClock(new Date(iso)), timeoutMs: 0,
  }).extractEpisode(ep);

  const first = await extractAt("2026-11-19T00:00:00.000Z");
  const second = await extractAt("2026-11-20T00:00:00.000Z");
  assert.equal(first.accepted.length, 1);
  assert.notEqual(
    first.accepted[0]!.statement.recordedAt,
    second.accepted[0]!.statement.recordedAt,
    "the two extractions really carry different clock values",
  );
  assert.equal(first.accepted[0]!.statement.id, second.accepted[0]!.statement.id);

  const store = new InMemoryStatementStore();
  for (const w of first.accepted) await store.insert({}, w);
  for (const w of second.accepted) await store.insert({}, w);

  assert.equal(store.allStatements().length, 1, "no duplicate statement");
  assert.equal(store.allEvidence().length, 1, "no duplicate evidence");
  assert.equal(store.allEntities().length, 2, "no duplicate entities");
  assert.equal(
    store.allStatements()[0]!.recordedAt,
    first.accepted[0]!.statement.recordedAt,
    "first-write recordedAt is preserved on the retry",
  );
});

test("a genuine immutable-content change still conflicts across different clocks", async () => {
  const store = new InMemoryStatementStore();
  await store.insert({}, write({ statement: statement({ recordedAt: "2026-11-19T00:00:00.000Z" }) }));

  await assert.rejects(
    () => store.insert({}, write({
      statement: statement({
        predicate: "must_not_use",
        recordedAt: "2026-11-20T00:00:00.000Z",
      }),
    })),
    (err: unknown) => err instanceof ConflictError && err.message.includes("different immutable content"),
    "a changed immutable field must conflict even though recordedAt also differs",
  );

  assert.equal(store.allStatements().length, 1);
  assert.equal(
    store.allStatements()[0]!.recordedAt,
    "2026-11-19T00:00:00.000Z",
    "the rejected write must not replace first-write metadata",
  );
});

test("a repeated identical write keeps one statement and its provenance links", async () => {
  const store = new InMemoryStatementStore();
  const first = await store.insert({}, write());
  const second = await store.insert({}, write({
    statement: statement({ recordedAt: "2026-11-20T00:00:00.000Z" }),
  }));

  assert.equal(second.id, first.id);
  assert.equal(store.allStatements().length, 1);
  assert.equal(store.allEvidence().length, 1);
  assert.equal(store.allEntities().length, 2);
  assert.deepEqual(store.evidenceFor("stmt:1").map((e) => e.id), ["ev:1"]);
  assert.equal(store.allStatements()[0]!.recordedAt, AT, "first-write metadata survives the retry");
});

test("a repeated write with additional evidence links it to the existing statement", async () => {
  const store = new InMemoryStatementStore();
  await store.insert({}, write());
  const added = evidence({ id: "ev:2", spanStart: 23, spanEnd: 43, quote: " for the new service" });
  await store.insert({}, write({ evidence: [evidence(), added] }));

  assert.equal(store.allStatements().length, 1, "the statement is not duplicated");
  assert.deepEqual(store.allEvidence().map((e) => e.id).sort(), ["ev:1", "ev:2"]);
  assert.deepEqual(store.evidenceFor("stmt:1").map((e) => e.id), ["ev:1", "ev:2"]);
  assert.equal(store.allStatements()[0]!.recordedAt, AT);
});

test("a conflicting immutable-content write cannot smuggle in extra evidence", async () => {
  const store = new InMemoryStatementStore();
  await store.insert({}, write());

  await assert.rejects(
    () => store.insert({}, write({
      statement: statement({ predicate: "must_not_use" }),
      evidence: [evidence(), evidence({ id: "ev:2", spanStart: 23, spanEnd: 43, quote: " for the new service" })],
    })),
    (err: unknown) => err instanceof ConflictError,
  );

  assert.equal(store.allStatements().length, 1);
  assert.deepEqual(store.allEvidence().map((e) => e.id), ["ev:1"], "the conflicting write's evidence is not persisted");
  assert.deepEqual(store.evidenceFor("stmt:1").map((e) => e.id), ["ev:1"]);
});

test("an evidence id reused with different content keeps first-write content (Neo4j MERGE parity)", async () => {
  const store = new InMemoryStatementStore();
  await store.insert({}, write());
  await store.insert({}, write({
    evidence: [evidence({ quote: "different text", spanStart: 2, spanEnd: 16 })],
  }));

  assert.equal(store.allEvidence().length, 1);
  assert.equal(store.allEvidence()[0]!.quote, "We should use Postgres", "ON CREATE SET is first-write only in Neo4j too");
  assert.deepEqual(store.evidenceFor("stmt:1").map((e) => e.id), ["ev:1"], "no duplicate SUPPORTED_BY link");
});

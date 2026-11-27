import { test } from "node:test";
import assert from "node:assert/strict";
import { fixedClock } from "../core/clock.js";
import { ConflictError, ValidationError } from "../core/errors.js";
import type { Entity, Episode, MergePlan, SplitPlan } from "../contracts/schemas.js";
import { ExtractionService } from "../extraction/extractEpisode.js";
import { ExtractionJobHandler } from "../extraction/extractionJobHandler.js";
import { InMemoryJobLedger } from "../fakes/memoryJobLedger.js";
import { InMemoryResolutionStore } from "../fakes/memoryResolutionStore.js";
import { InMemoryStatementStore } from "../fakes/memoryStatementStore.js";
import { FakeLLMProvider } from "../fakes/providers.js";
import { JobWorker } from "../jobs/worker.js";
import { EntityResolutionService } from "./service.js";

const AT = "2026-11-23T00:00:00.000Z";
const entity = (over: Partial<Entity> = {}): Entity => ({
  id: "ent-source",
  type: "product",
  canonicalName: "HubSpot",
  aliases: [],
  status: "active",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  ...over,
});

const setup = () => {
  const clock = fixedClock(new Date(AT));
  const statements = new InMemoryStatementStore();
  const store = new InMemoryResolutionStore(statements, clock);
  return { clock, statements, store, service: new EntityResolutionService(store, { clock }) };
};

test("resolve records no durable output and never merges", async () => {
  const { store, service } = setup();
  await store.putEntity({}, entity({ aliases: ["HSM"] }));
  const decision = await service.resolve({ mention: { name: "HSM", type: "product" }, episodeId: "ep-1" });

  assert.equal(decision.outcome, "matched");
  assert.ok("entityId" in decision && decision.entityId === "ent-source");
  assert.deepEqual(await store.mergeEdges(), []);
  assert.deepEqual(await store.mergeEvents(), []);
  assert.deepEqual(await store.outcomes(), []);
});

test("merge requires authorization, preserves both records and is idempotent", async () => {
  const { store, service } = setup();
  await store.putEntity({}, entity({ id: "ent-source", aliases: ["HSM"] }));
  await store.putEntity({}, entity({ id: "ent-target", canonicalName: "HubSpot Inc" }));
  const plan: MergePlan = {
    sourceId: "ent-source", targetId: "ent-target",
    authorization: "user-confirmed:u1", reason: "same vendor", aliases: ["HSM"],
  };

  const first = await service.merge({}, plan);
  const second = await service.merge({}, plan);
  assert.equal(second.id, first.id);
  assert.equal((await store.mergeEvents()).length, 1);
  assert.deepEqual(await store.mergeEdges(), [{ from: "ent-source", to: "ent-target" }]);
  const source = await store.entityById("ent-source");
  const target = await store.entityById("ent-target");
  assert.equal(source!.status, "merged");
  assert.ok(target!.aliases.includes("HSM"));
  assert.equal((await store.entities()).length, 2, "both records survive");
});

test("merge rejects self-links, cycles, unowned aliases and conflicting retries", async () => {
  const { store, service } = setup();
  await store.putEntity({}, entity({ id: "ent-a", canonicalName: "Atlas" }));
  await store.putEntity({}, entity({ id: "ent-b", canonicalName: "Atlas CRM" }));

  await assert.rejects(
    () => service.merge({}, { sourceId: "ent-a", targetId: "ent-a", authorization: "a", reason: "bad", aliases: [] }),
    ValidationError,
  );
  await assert.rejects(
    () => service.merge({}, {
      sourceId: "ent-a", targetId: "ent-b", authorization: "a", reason: "alias", aliases: ["NOT-OWNED"],
    }),
    ValidationError,
  );

  store.seedMergeEdge("ent-b", "ent-a");
  await assert.rejects(
    () => service.merge({}, { sourceId: "ent-a", targetId: "ent-b", authorization: "a", reason: "cycle", aliases: [] }),
    (err: unknown) => err instanceof ConflictError && err.message.includes("cycle"),
  );
  assert.equal((await store.mergeEdges()).length, 1, "the rejected merge added no edge");
});

test("split reassigns only the listed items and transfers only listed aliases", async () => {
  const { store, service } = setup();
  await store.putEntity({}, entity({ aliases: ["HSM", "HubSpot CRM"] }));
  store.seedLinks("ent-source", ["stmt:1", "stmt:2"], ["ev:1", "ev:2"]);
  const plan: SplitPlan = {
    sourceId: "ent-source", canonicalName: "HubSpot Marketing", type: "product",
    statementIds: ["stmt:1"], evidenceIds: ["ev:1"], aliases: ["HSM"],
    authorization: "user-split:u1", reason: "separate product",
  };

  const first = await service.split({}, plan);
  const second = await service.split({}, plan);
  assert.equal(second.id, first.id);
  assert.equal((await store.splitEvents()).length, 1);

  const source = (await store.entityById("ent-source"))!;
  const created = (await store.entityById(first.newEntityId))!;
  assert.equal(source.status, "split");
  assert.deepEqual(source.aliases, ["HubSpot CRM"], "unlisted alias stays with the source");
  assert.deepEqual(created.aliases, ["HSM"], "only the listed alias is transferred");
  assert.deepEqual(await store.statementIdsForEntity(first.newEntityId), ["stmt:1"]);
  assert.deepEqual(await store.statementIdsForEntity("ent-source"), ["stmt:2"]);
});

test("split rejects empty, ambiguous and unlisted reassignments", async () => {
  const { store, service } = setup();
  await store.putEntity({}, entity({ aliases: ["HSM"] }));
  store.seedLinks("ent-source", ["stmt:1"], ["ev:1"]);

  await assert.rejects(
    () => service.split({}, {
      sourceId: "ent-source", canonicalName: "New", type: "product",
      statementIds: [], evidenceIds: [], aliases: [], authorization: "a", reason: "empty",
    }),
    ValidationError,
  );
  await assert.rejects(
    () => service.split({}, {
      sourceId: "ent-source", canonicalName: "New", type: "product",
      statementIds: ["stmt:99"], evidenceIds: [], aliases: [], authorization: "a", reason: "unlisted",
    }),
    ValidationError,
  );
  assert.equal((await store.splitEvents()).length, 0);
});

test("extraction integration records resolutions inside the fenced commit", async () => {
  const clock = fixedClock(new Date(AT));
  const TEXT = "We should use Postgres for the new service.";
  const episode: Episode = {
    id: "ep-int", externalId: "ext-int", sessionId: "sess", seq: 0,
    role: "user", text: TEXT, occurredAt: "2026-11-16T09:00:00.000Z",
    precision: "second", tz: "UTC", source: "chat", createdAt: "2026-11-16T09:00:00.000Z",
  };
  const provider = new FakeLLMProvider(() => ({
    text: JSON.stringify({ candidates: [{
      subject: { name: "We" },
      predicate: "should use",
      object: { kind: "entity", name: "Postgres", type: "product" },
      polarity: "positive", modality: "proposed", decisionStatus: "proposed", confidence: 0.8,
      evidence: { quote: TEXT, spanStart: 0, spanEnd: TEXT.length },
    }] }),
    model: "fake-llm-1",
    usage: { inputTokens: 10, outputTokens: 5 },
    finishReason: "stop",
  }));
  const statements = new InMemoryStatementStore();
  const store = new InMemoryResolutionStore(statements, clock);
  await store.putEntity({}, entity({ id: "ent-postgres", canonicalName: "Postgres" }));
  const resolver = new EntityResolutionService(store, { clock });
  const handler = new ExtractionJobHandler<object>({
    episodes: { byId: async (id) => (id === episode.id ? episode : null) },
    extractor: new ExtractionService({ provider, clock, timeoutMs: 0 }),
    statements,
    resolver,
    resolutions: store,
    clock,
  });
  const ledger = new InMemoryJobLedger();
  const worker = new JobWorker<object>(ledger, [handler], { workerId: "w", leaseRenewMs: 0, idleDelayMs: 0 });
  ledger.enqueue("extract", { episodeId: episode.id }, "extract:int", { maxAttempts: 1 });

  assert.equal(await worker.runOnce(), "completed");
  assert.equal(statements.size, 1);
  const statement = statements.allStatements()[0]!;
  const originalObjectId = statement.objectId!;
  const outcomes = await store.outcomes();
  assert.equal(outcomes.length, 2, "subject and object mentions are both recorded");
  assert.ok(outcomes.some((o) => o.outcome === "matched" && o.entityId === "ent-postgres"));
  assert.deepEqual(await store.mergeEdges(), [], "a matched alias link is not a merge");
  assert.equal(statement.subjectId.startsWith("ent:"), true, "slice 3 statement ids are untouched");

  // The decision is now applied to the graph's identity references, while the
  // statement id, its evidence and its immutable properties stay as extracted.
  assert.ok((await store.statementIdsForEntity("ent-postgres")).includes(statement.id));
  assert.ok(!(await store.statementIdsForEntity(originalObjectId)).includes(statement.id));
  assert.equal((await statements.byId(statement.id))!.objectId, originalObjectId);
  assert.equal(statements.evidenceFor(statement.id).length, 1);
  assert.ok((await store.entityById("ent-postgres"))!.aliases.includes("Postgres"));
});

test("subject query paths agree on the resolved entity, not the mention-scoped id", async () => {
  const clock = fixedClock(new Date(AT));
  const TEXT = "We should use Postgres for the new service.";
  const episode: Episode = {
    id: "ep-subject-query", externalId: "ext-subject-query", sessionId: "sess", seq: 0,
    role: "user", text: TEXT, occurredAt: "2026-11-16T09:00:00.000Z",
    precision: "second", tz: "UTC", source: "chat", createdAt: "2026-11-16T09:00:00.000Z",
  };
  const provider = new FakeLLMProvider(() => ({
    text: JSON.stringify({ candidates: [{
      subject: { name: "We" }, predicate: "should use",
      object: { kind: "entity", name: "Postgres", type: "product" },
      polarity: "positive", modality: "proposed", decisionStatus: "proposed", confidence: 0.8,
      evidence: { quote: TEXT, spanStart: 0, spanEnd: TEXT.length },
    }] }),
    model: "fake-llm-1", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop",
  }));
  const statements = new InMemoryStatementStore();
  const store = new InMemoryResolutionStore(statements, clock);
  await store.putEntity({}, entity({ id: "ent-we", type: "concept", canonicalName: "We" }));
  const handler = new ExtractionJobHandler<object>({
    episodes: { byId: async () => episode },
    extractor: new ExtractionService({ provider, clock, timeoutMs: 0 }),
    statements,
    resolver: new EntityResolutionService(store, { clock }),
    resolutions: store,
    clock,
  });
  const ledger = new InMemoryJobLedger();
  const worker = new JobWorker<object>(ledger, [handler], { workerId: "w", leaseRenewMs: 0, idleDelayMs: 0 });
  ledger.enqueue("extract", { episodeId: episode.id }, "extract:subject-query", { maxAttempts: 1 });
  assert.equal(await worker.runOnce(), "completed");

  const statement = statements.allStatements()[0]!;
  const mentionScopedId = statement.subjectId; // immutable property stays as extracted
  const resolvedId = (await store.outcomes()).find((o) => o.outcome === "matched")!.entityId!;
  assert.equal(resolvedId, "ent-we");

  assert.deepEqual((await statements.forSubject(resolvedId)).map((s) => s.id), [statement.id]);
  assert.deepEqual((await statements.activeAt({ subjectId: resolvedId })).map((s) => s.id), [statement.id]);
  assert.deepEqual(await statements.forSubject(mentionScopedId), [], "the old mention id no longer owns the statement");
  assert.deepEqual(await statements.activeAt({ subjectId: mentionScopedId }), []);
  assert.equal((await statements.byId(statement.id))!.subjectId, mentionScopedId, "immutable property is unchanged");
});

test("a new_entity decision persists its generated id and re-points the statement", async () => {
  const clock = fixedClock(new Date(AT));
  const TEXT = "We should use Postgres for the new service.";
  const episode: Episode = {
    id: "ep-new", externalId: "ext-new", sessionId: "sess", seq: 0,
    role: "user", text: TEXT, occurredAt: "2026-11-16T09:00:00.000Z",
    precision: "second", tz: "UTC", source: "chat", createdAt: "2026-11-16T09:00:00.000Z",
  };
  const provider = new FakeLLMProvider(() => ({
    text: JSON.stringify({ candidates: [{
      subject: { name: "We" },
      predicate: "should use",
      object: { kind: "entity", name: "Postgres", type: "product" },
      polarity: "positive", modality: "proposed", decisionStatus: "proposed", confidence: 0.8,
      evidence: { quote: TEXT, spanStart: 0, spanEnd: TEXT.length },
    }] }),
    model: "fake-llm-1", usage: { inputTokens: 10, outputTokens: 5 }, finishReason: "stop",
  }));
  const statements = new InMemoryStatementStore();
  const store = new InMemoryResolutionStore(statements, clock);
  const handler = new ExtractionJobHandler<object>({
    episodes: { byId: async () => episode },
    extractor: new ExtractionService({ provider, clock, timeoutMs: 0 }),
    statements,
    resolver: new EntityResolutionService(store, { clock }),
    resolutions: store,
    clock,
  });
  const ledger = new InMemoryJobLedger();
  const worker = new JobWorker<object>(ledger, [handler], { workerId: "w", leaseRenewMs: 0, idleDelayMs: 0 });
  ledger.enqueue("extract", { episodeId: episode.id }, "extract:new", { maxAttempts: 1 });

  assert.equal(await worker.runOnce(), "completed");
  const statement = statements.allStatements()[0]!;
  const originalObjectId = statement.objectId!;
  const created = (await store.outcomes()).filter((o) => o.outcome === "new_entity" && o.createdEntity);
  assert.equal(created.length, 2, "both mentions resolve to new identities");
  for (const outcome of created) {
    const id = outcome.createdEntity!.id;
    assert.ok(await store.entityById(id), "the generated entity is persisted, not just recorded");
    assert.ok((await store.statementIdsForEntity(id)).includes(statement.id), "its references are re-pointed");
  }
  assert.equal((await statements.byId(statement.id))!.objectId, originalObjectId, "statement content is unchanged");
});

test("a fenced-out extraction commits neither statements nor resolution outcomes", async () => {
  const clock = fixedClock(new Date(AT));
  const TEXT = "We should use Postgres for the new service.";
  const episode: Episode = {
    id: "ep-fence", externalId: "ext-fence", sessionId: "sess", seq: 0,
    role: "user", text: TEXT, occurredAt: "2026-11-16T09:00:00.000Z",
    precision: "second", tz: "UTC", source: "chat", createdAt: "2026-11-16T09:00:00.000Z",
  };
  const provider = new FakeLLMProvider(() => ({
    text: JSON.stringify({ candidates: [{
      subject: { name: "We" }, predicate: "should use",
      object: { kind: "entity", name: "Postgres", type: "product" },
      polarity: "positive", modality: "proposed", decisionStatus: "proposed", confidence: 0.8,
      evidence: { quote: TEXT, spanStart: 0, spanEnd: TEXT.length },
    }] }),
    model: "fake-llm-1", usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop",
  }));
  const statements = new InMemoryStatementStore();
  const store = new InMemoryResolutionStore(statements, clock);
  const handler = new ExtractionJobHandler<object>({
    episodes: { byId: async () => episode },
    extractor: new ExtractionService({ provider, clock, timeoutMs: 0 }),
    statements,
    resolver: new EntityResolutionService(store, { clock }),
    resolutions: store,
    clock,
  });
  const ledger = new InMemoryJobLedger();
  const worker = new JobWorker<object>(ledger, [handler], { workerId: "w", leaseRenewMs: 0, idleDelayMs: 0 });
  ledger.enqueue("extract", { episodeId: episode.id }, "extract:fence", { maxAttempts: 1 });
  ledger.failNextFence(1);

  assert.equal(await worker.runOnce(), "stale");
  assert.equal(statements.size, 0);
  assert.deepEqual(await store.outcomes(), [], "staged resolution output rolls back with the fence");
  assert.deepEqual(await store.entities(), [], "no generated entity survives a lost fence");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { fixedClock } from "../core/clock.js";
import { NotFoundError, ValidationError } from "../core/errors.js";
import type { CorrectionPlan, Statement } from "../contracts/schemas.js";
import type { StatementWrite } from "../contracts/ports.js";
import { InMemoryJobLedger } from "../fakes/memoryJobLedger.js";
import { InMemoryLifecycleStore } from "../fakes/memoryLifecycleStore.js";
import { InMemoryStatementStore } from "../fakes/memoryStatementStore.js";
import { JobWorker } from "../jobs/worker.js";
import { statementContentHash } from "../memory/statementContent.js";
import { CorrectionJobHandler } from "./correctionJobHandler.js";
import { CorrectionService } from "./correctionService.js";

const AT = "2026-11-20T00:00:00.000Z";

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
    id: `ev:${id}`,
    kind: "episode_span",
    episodeId: `ep:${id}`,
    messageExternalId: `ext:${id}`,
    spanStart: 0,
    spanEnd: 9,
    quote: "quoted ev",
  }],
  entities: [{
    id: "ent:subj", type: "concept", canonicalName: "Subject", aliases: [],
    status: "active", createdAt: recordedAt, updatedAt: recordedAt,
  }],
});

const setup = () => {
  const clock = fixedClock(new Date(AT));
  const lifecycle = new InMemoryLifecycleStore();
  const statements = new InMemoryStatementStore(lifecycle);
  return { clock, lifecycle, statements, service: new CorrectionService(statements, lifecycle, { clock }) };
};

test("a supersession appends an event and preserves the original statement", async () => {
  const { statements, lifecycle, service } = setup();
  await statements.insert({}, write("st-1", "2026-11-03T00:00:00.000Z"));
  const fingerprint = statementContentHash((await statements.byId("st-1"))!);
  const originalHash = fingerprint;
  const plan: CorrectionPlan = {
    kind: "supersede", targetId: "st-1", expectedFingerprint: fingerprint,
    replacement: write("st-2", AT, { predicate: "selected", objectValue: "HubSpot" }),
    reason: "decision changed", actor: "user",
  };

  const result = await service.correct({}, plan);
  assert.equal(result.status, "applied");
  assert.equal((await lifecycle.events()).length, 1);
  assert.ok((await lifecycle.edges()).some((e) => e.kind === "SUPERSEDES" && e.from === "st-2" && e.to === "st-1"));
  assert.equal(statementContentHash((await statements.byId("st-1"))!), originalHash, "original content is immutable");
  assert.deepEqual((await statements.activeAt({})).map((s) => s.id), ["st-2"]);
  assert.deepEqual(
    (await statements.activeAt({ asOfTx: new Date("2026-11-10T00:00:00.000Z") })).map((s) => s.id),
    ["st-1"],
    "historical query sees the earlier belief",
  );
});

test("retraction needs no replacement and keeps the original", async () => {
  const { statements, lifecycle, service } = setup();
  await statements.insert({}, write("st-1", "2026-11-03T00:00:00.000Z"));
  const fingerprint = statementContentHash((await statements.byId("st-1"))!);
  await service.correct({}, {
    kind: "retract", targetId: "st-1", expectedFingerprint: fingerprint,
    reason: "unsupported", actor: "user",
  });
  assert.deepEqual(await statements.activeAt({}), []);
  assert.equal(statements.size, 1);
  assert.ok((await lifecycle.edges()).some((e) => e.kind === "RETRACTS"));
  assert.deepEqual(
    (await statements.activeAt({ asOfTx: new Date("2026-11-10T00:00:00.000Z") })).map((s) => s.id),
    ["st-1"],
  );
});

test("a conflict surfaces both assertions without choosing a winner", async () => {
  const { statements, lifecycle, service } = setup();
  await statements.insert({}, write("st-1", "2026-11-03T00:00:00.000Z"));
  await statements.insert({}, write("st-2", "2026-11-04T00:00:00.000Z", { objectValue: "HubSpot" }));
  const a = statementContentHash((await statements.byId("st-1"))!);
  const b = statementContentHash((await statements.byId("st-2"))!);
  await service.correct({}, {
    kind: "conflict", targetId: "st-1", otherId: "st-2",
    expectedFingerprint: a, otherFingerprint: b, reason: "sources disagree", actor: "user",
  });
  assert.equal((await lifecycle.events()).length, 2);
  assert.deepEqual((await statements.activeAt({})).map((s) => s.id).sort(), ["st-1", "st-2"]);
});

test("a stale or wrong target is rejected, never guessed", async () => {
  const { statements, lifecycle, service } = setup();
  await statements.insert({}, write("st-1", "2026-11-03T00:00:00.000Z"));
  await assert.rejects(
    () => service.correct({}, {
      kind: "retract", targetId: "st-missing", expectedFingerprint: "abc", reason: "x", actor: "user",
    }),
    NotFoundError,
  );
  await assert.rejects(
    () => service.correct({}, {
      kind: "retract", targetId: "st-1", expectedFingerprint: "wrong", reason: "x", actor: "user",
    }),
    ValidationError,
  );
  assert.equal((await lifecycle.events()).length, 0);
});

test("repeating a correction is idempotent", async () => {
  const { statements, lifecycle, service } = setup();
  await statements.insert({}, write("st-1", "2026-11-03T00:00:00.000Z"));
  const fingerprint = statementContentHash((await statements.byId("st-1"))!);
  const plan: CorrectionPlan = {
    kind: "retract", targetId: "st-1", expectedFingerprint: fingerprint, reason: "x", actor: "user",
  };
  const first = await service.correct({}, plan);
  const second = await service.correct({}, plan);
  assert.equal(first.status, "applied");
  assert.equal(second.status, "already_applied");
  assert.deepEqual(second.eventIds, first.eventIds);
  assert.equal((await lifecycle.events()).length, 1);
});

test("a lost fence rolls back lifecycle output", async () => {
  const { statements, lifecycle, service } = setup();
  await statements.insert({}, write("st-1", "2026-11-03T00:00:00.000Z"));
  const fingerprint = statementContentHash((await statements.byId("st-1"))!);
  const plan: CorrectionPlan = {
    kind: "retract", targetId: "st-1", expectedFingerprint: fingerprint, reason: "x", actor: "user",
  };
  const ledger = new InMemoryJobLedger();
  const worker = new JobWorker<object>(
    ledger, [new CorrectionJobHandler(service)],
    { workerId: "w", leaseRenewMs: 0, idleDelayMs: 0 },
  );
  ledger.enqueue("correct", { plan }, "correct:stale", { maxAttempts: 1 });
  ledger.failNextFence(1);

  assert.equal(await worker.runOnce(), "stale");
  assert.equal((await lifecycle.events()).length, 0);
  assert.deepEqual((await statements.activeAt({})).map((s) => s.id), ["st-1"]);
});

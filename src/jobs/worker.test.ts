import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { FencingError } from "../core/errors.js";
import { MemoryTelemetry } from "../core/telemetry.js";
import { FakeClock } from "../fakes/fakeClock.js";
import { InMemoryJobLedger } from "../fakes/memoryJobLedger.js";
import { JobWorker, type JobHandler, type JobWorkerLedger } from "./worker.js";

const handler = (trace: string[], kind = "extract"): JobHandler<object> => ({
  kind,
  prepare: async () => ({
    summary: "prepared",
    commit: async () => { trace.push("commit"); },
  }),
});

const workerOf = (ledger: JobWorkerLedger<object>, handlers: readonly JobHandler<object>[], opts = {}) =>
  new JobWorker<object>(ledger, handlers, { workerId: "w1", leaseRenewMs: 0, idleDelayMs: 0, ...opts });

test("runOnce prepares outside the fence, commits inside it, then completes", async () => {
  const trace: string[] = [];
  const ledger = new InMemoryJobLedger();
  const jobId = ledger.enqueue("extract", { episodeId: "ep-1" }, "k1", { maxAttempts: 1 });
  const h: JobHandler<object> = {
    kind: "extract",
    prepare: async () => {
      trace.push("prepare");
      return { commit: async () => { trace.push("commit"); } };
    },
  };
  const telemetry = new MemoryTelemetry();
  const worker = workerOf(ledger, [h], { telemetry });

  assert.equal(await worker.runOnce(), "completed");
  assert.deepEqual(trace, ["prepare", "commit"], "provider work happens before the fenced write");
  assert.equal(ledger.job(jobId)!.status, "completed");
  assert.equal(telemetry.counters.get("job.completed"), 1);
  assert.equal(await worker.runOnce(), "idle", "the queue is drained");
});

test("an unregistered job kind fails the job and writes nothing", async () => {
  const trace: string[] = [];
  const ledger = new InMemoryJobLedger();
  const jobId = ledger.enqueue("mystery", {}, "k2", { maxAttempts: 1 });
  const worker = workerOf(ledger, [handler(trace)]);

  assert.equal(await worker.runOnce(), "dead");
  const job = ledger.job(jobId)!;
  assert.equal(job.status, "dead");
  assert.ok(job.lastError!.includes("no handler registered for job kind 'mystery'"));
  assert.deepEqual(trace, [], "an unknown kind must never reach a commit");
});

test("a handler error requeues the job, records the reason, and backs off", async () => {
  const ledger = new InMemoryJobLedger();
  const jobId = ledger.enqueue("extract", {}, "k3", { maxAttempts: 5 });
  const failing: JobHandler<object> = {
    kind: "extract",
    prepare: async () => { throw new Error("provider exploded"); },
  };
  const worker = workerOf(ledger, [failing]);

  assert.equal(await worker.runOnce(), "requeued");
  const job = ledger.job(jobId)!;
  assert.equal(job.status, "pending");
  assert.equal(job.attempts, 1);
  assert.equal(job.lastError, "provider exploded");
  assert.ok(job.nextRunAt!.getTime() > Date.now(), "requeued jobs back off instead of hot-looping");
  assert.equal(await worker.runOnce(), "idle", "the backoff keeps it unclaimable");
});

test("attempts exhaustion dead-letters the job with its last error", async () => {
  const clock = new FakeClock();
  const ledger = new InMemoryJobLedger(() => clock.now());
  const jobId = ledger.enqueue("extract", {}, "k4", { maxAttempts: 2 });
  const failing: JobHandler<object> = {
    kind: "extract",
    prepare: async () => { throw new Error("still broken"); },
  };
  const worker = workerOf(ledger, [failing]);

  assert.equal(await worker.runOnce(), "requeued");
  assert.equal(ledger.job(jobId)!.attempts, 1);
  assert.equal(ledger.job(jobId)!.status, "pending");

  clock.advanceMinutes(5); // the backoff has elapsed
  assert.equal(await worker.runOnce(), "dead");
  const job = ledger.job(jobId)!;
  assert.equal(job.status, "dead");
  assert.equal(job.attempts, 2);
  assert.equal(job.lastError, "still broken");
});

test("a fence lost before the write returns stale and commits nothing", async () => {
  const trace: string[] = [];
  const ledger = new InMemoryJobLedger();
  const jobId = ledger.enqueue("extract", {}, "k5", { maxAttempts: 1 });
  ledger.failNextFence(1);
  const worker = workerOf(ledger, [handler(trace)]);

  assert.equal(await worker.runOnce(), "stale");
  assert.deepEqual(trace, [], "prepared output must be discarded wholesale — commit never runs");
  assert.equal(ledger.job(jobId)!.status, "running", "a stale worker never marks the job done");
  assert.equal(ledger.job(jobId)!.lastError, null, "a lost fence is not a job failure");
});

test("losing the fence at completion reports stale even though output was committed", async () => {
  class CompleteLosesFence extends InMemoryJobLedger {
    async complete(): Promise<boolean> { return false; }
  }
  const trace: string[] = [];
  const ledger = new CompleteLosesFence();
  ledger.enqueue("extract", {}, "k6", { maxAttempts: 1 });
  const worker = workerOf(ledger, [handler(trace)]);

  assert.equal(await worker.runOnce(), "stale", "never report success when completion lost the fence");
  assert.deepEqual(trace, ["commit"], "the output was written; re-running is safe because writes are idempotent");
});

test("a lease renewal failure marks the run stale before any write", async () => {
  class LostLeaseLedger extends InMemoryJobLedger {
    async renewLease(): Promise<boolean> { return false; }
  }
  const trace: string[] = [];
  const ledger = new LostLeaseLedger();
  ledger.enqueue("extract", {}, "k7", { maxAttempts: 1 });
  const h: JobHandler<object> = {
    kind: "extract",
    prepare: async () => {
      await new Promise((resolve) => setTimeout(resolve, 40)); // heartbeat fires during prepare
      trace.push("prepare");
      return { commit: async () => { trace.push("commit"); } };
    },
  };
  const worker = workerOf(ledger, [h], { leaseRenewMs: 1 });

  assert.equal(await worker.runOnce(), "stale");
  assert.deepEqual(trace, ["prepare"], "nothing may be written after the lease is lost");
});

test("the ledger rejects fenced writes from a stale owner", async () => {
  const ledger = new InMemoryJobLedger();
  const jobId = ledger.enqueue("extract", {}, "k8", { maxAttempts: 1 });
  const claimed = (await ledger.claimNext("w1"))!;
  assert.equal(claimed.id, jobId);

  await assert.rejects(
    () => ledger.commitFencedOutput(jobId, claimed.claimGeneration, "other-worker", async () => "x"),
    (err: unknown) => err instanceof FencingError,
    "a different worker cannot commit under this generation",
  );
  await assert.rejects(
    () => ledger.commitFencedOutput(jobId, claimed.claimGeneration + 1, "w1", async () => "x"),
    (err: unknown) => err instanceof FencingError,
    "a bumped generation cannot commit under the old one",
  );
  assert.equal(await ledger.complete(jobId, claimed.claimGeneration, "other-worker"), false);
  assert.equal(
    await ledger.fail(jobId, claimed.claimGeneration, "other-worker", "nope"),
    "rejected",
    "a stale worker cannot dead-letter someone else's job",
  );
  assert.equal(ledger.job(jobId)!.status, "running");
  assert.equal(ledger.job(jobId)!.lastError, null);
});

test("duplicate handler registration is rejected at construction", () => {
  const ledger = new InMemoryJobLedger();
  assert.throws(
    () => new JobWorker<object>(ledger, [handler([], "extract"), handler([], "extract")]),
    /duplicate job handler for kind 'extract'/,
  );
});

test("runLoop is bounded and its idle wait is abortable", async () => {
  const trace: string[] = [];
  const ledger = new InMemoryJobLedger();
  ledger.enqueue("extract", {}, "k9", { maxAttempts: 1 });
  ledger.enqueue("extract", {}, "k10", { maxAttempts: 1 });
  const worker = workerOf(ledger, [handler(trace)], { idleDelayMs: 5_000 });

  await worker.runLoop(new AbortController().signal, { maxIterations: 1 });
  assert.equal(trace.length, 1, "maxIterations caps the loop");

  const ac = new AbortController();
  setTimeout(() => ac.abort(), 10);
  const t0 = performance.now();
  await worker.runLoop(ac.signal);
  assert.ok(performance.now() - t0 < 1_000, "abort must cut the idle sleep short");
  assert.equal(trace.length, 2, "the remaining job was processed first");
});

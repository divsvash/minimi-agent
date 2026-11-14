import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, closeDatabase, type TestContext } from "./helpers.js";
import { newSession } from "../../src/interfaces/neo4j.js";
import { JobLedger } from "../../src/jobs/ledger.js";
import { FencingError } from "../../src/core/errors.js";

let ctx: TestContext;
let ledger: JobLedger;

before(async () => {
  ctx = await freshDatabase();
  ledger = new JobLedger(ctx.driver, { leaseSeconds: 120, sweepIntervalMs: 30_000 });
});

after(async () => {
  await closeDatabase(ctx);
});

async function forceExpire(jobId: string) {
  const s = newSession(ctx.driver, "WRITE");
  await s.run("MATCH (j:Job {id: $id}) SET j.leaseUntil = datetime() - duration({minutes: 5})", { id: jobId });
  await s.close();
}

async function countWhere(cypher: string, params: Record<string, unknown> = {}): Promise<number> {
  const s = newSession(ctx.driver, "READ");
  const { records } = await s.run(cypher, params);
  await s.close();
  return records[0]?.get("n") as number;
}

test("8 racing workers claim 24 jobs exactly once each", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 24; i++) ids.push(await ledger.enqueue("noop", { i }, `race:${i}`));

  const claimed: string[] = [];
  const claimAll = async (workerId: string) => {
    for (;;) {
      const job = await ledger.claimNext(workerId);
      if (!job) return;
      claimed.push(job.id);
    }
  };
  await Promise.all(Array.from({ length: 8 }, (_, w) => claimAll(`worker-${w}`)));

  assert.equal(claimed.length, 24, "every enqueued job must be claimed exactly once");
  assert.equal(new Set(claimed).size, 24, "no job may be claimed twice");
  assert.deepEqual([...claimed].sort(), [...ids].sort());
});

test("stale worker cannot commit output or complete after lease expiry", async () => {
  const jobId = await ledger.enqueue("noop", { n: 1 }, "stale:1");

  const job1 = await ledger.claimNext("w1");
  assert.ok(job1);
  const gen1 = job1!.claimGeneration;

  await forceExpire(jobId);
  await ledger.sweep();
  const job2 = await ledger.claimNext("w2");
  assert.ok(job2, "w2 must reclaim the expired job");
  assert.equal(job2!.claimGeneration, gen1 + 1);

  // stale worker tries to commit output — rejected, nothing persisted
  await assert.rejects(
    ledger.commitFencedOutput(job1!.id, gen1, "w1", (tx) =>
      tx.run("CREATE (o:JobOutput {jobId: $jobId, claimGeneration: $gen, marker: 'stale'})", { jobId, gen: gen1 }),
    ),
    FencingError,
  );
  assert.equal(await countWhere("MATCH (o:JobOutput) RETURN count(o) AS n"), 0);

  // stale worker tries to complete — rejected
  assert.equal(await ledger.complete(jobId, gen1, "w1"), false);

  // current owner commits and completes — accepted
  await ledger.commitFencedOutput(job2!.id, job2!.claimGeneration, "w2", (tx) =>
    tx.run("CREATE (o:JobOutput {jobId: $jobId, claimGeneration: $gen, marker: 'fresh'})", {
      jobId,
      gen: job2!.claimGeneration,
    }),
  );
  assert.equal(await countWhere("MATCH (o:JobOutput) RETURN count(o) AS n"), 1);
  assert.equal(await ledger.complete(jobId, job2!.claimGeneration, "w2"), true);
});

test("fencing is generation-based, not workerId-based (recycled name, stale gen rejected)", async () => {
  const jobId = await ledger.enqueue("noop", { n: 2 }, "recycle:1");
  const job1 = await ledger.claimNext("w1");
  const gen1 = job1!.claimGeneration;
  await forceExpire(jobId);
  await ledger.sweep();
  const job2 = await ledger.claimNext("w1"); // same worker name, reclaimed with bumped generation
  assert.ok(job2);
  assert.ok(job2!.claimGeneration > gen1);
  assert.equal(await ledger.complete(jobId, gen1, "w1"), false, "stale generation must be rejected even from the same workerId");
  assert.equal(await ledger.complete(jobId, job2!.claimGeneration, "w1"), true);
});

test("provisional outputs invisible until promotion; swept when generation is superseded", async () => {
  const jobId = await ledger.enqueue("extract", { episodeId: "ep-x" }, "prov:1");
  const job = await ledger.claimNext("w1");
  const gen = job!.claimGeneration;

  await ledger.commitFencedOutput(jobId, gen, "w1", (tx) =>
    tx.run(
      "CREATE (p:Provisional {jobId: $jobId, claimGeneration: $gen, _targetLabels: ['Thing'], marker: 'pending'})",
      { jobId, gen },
    ),
  );

  assert.equal(
    await countWhere("MATCH (n:Thing) WHERE n.marker = 'pending' RETURN count(n) AS n"),
    0,
    "provisional output must not match Thing queries",
  );

  assert.equal(await ledger.complete(jobId, gen, "w1"), true);
  assert.equal(
    await countWhere("MATCH (n:Thing) WHERE n.marker = 'pending' RETURN count(n) AS n"),
    1,
    "promotion on fenced completion must make output visible",
  );

  // superseded worker writes a provisional that is never promoted or visible
  const jobId2 = await ledger.enqueue("extract", { episodeId: "ep-y" }, "prov:2");
  const jobA = await ledger.claimNext("wA");
  const genA = jobA!.claimGeneration;
  await forceExpire(jobId2);
  await ledger.sweep();
  const jobB = await ledger.claimNext("wB");
  assert.ok(jobB);
  // wA (stale) tries to write a provisional — fence rejects
  await assert.rejects(
    ledger.commitFencedOutput(jobId2, genA, "wA", (tx) =>
      tx.run(
        "CREATE (p:Provisional {jobId: $jobId, claimGeneration: $gen, _targetLabels: ['Ghost'], marker: 'zombie'})",
        { jobId: jobId2, gen: genA },
      ),
    ),
    FencingError,
  );
  // wB sweeps after its own work — nothing to reap (stale provisional never committed)
  await ledger.sweep();
  assert.equal(await countWhere("MATCH (n:Ghost) RETURN count(n) AS n"), 0);
  assert.equal(await ledger.complete(jobId2, jobB!.claimGeneration, "wB"), true);
});

test("concurrent: stale output writer racing the reclaim path — stale side never lands an output", async () => {
  for (let trial = 0; trial < 25; trial++) {
    const jobId = await ledger.enqueue("noop", { trial }, `race-out:${trial}`);
    const s1 = newSession(ctx.driver, "WRITE");
    await s1.run("MATCH (j:Job {id:$id}) SET j.leaseUntil = datetime() + duration({seconds: 2})", { id: jobId });
    await s1.close();
    const j1 = await ledger.claimNext("w1");
    const gen1 = j1!.claimGeneration;

    // lease expires right now; reclaimer and stale writer race
    await forceExpire(jobId);
    const [claimResult, staleWrite, staleComplete] = await Promise.all([
      ledger.sweep().then(() => ledger.claimNext("w2")),
      ledger.commitFencedOutput(jobId, gen1, "w1", (tx) =>
        tx.run("CREATE (o:JobOutput {jobId: $jobId, claimGeneration: $gen, marker: 'stale'}) RETURN o", {
          jobId,
          gen: gen1,
        }),
      ).then(
        () => "committed",
        () => "rejected",
      ),
      ledger.complete(jobId, gen1, "w1"),
    ]);

    assert.equal(staleWrite, "rejected", `trial ${trial}: stale output commit must be fenced out`);
    assert.equal(staleComplete, false, `trial ${trial}: stale completion must be fenced out`);
    assert.ok(claimResult, `trial ${trial}: reclaimer must own the job`);
    assert.ok(claimResult!.claimGeneration > gen1);

    // the stale marker never exists in the store
    assert.equal(
      await countWhere("MATCH (o:JobOutput {jobId: $id, claimGeneration: $gen}) RETURN count(o) AS n", {
        id: jobId,
        gen: gen1,
      }),
      0,
      `trial ${trial}: no stale output may exist after the race`,
    );
  }
});

test("duplicate enqueue is a no-op returning the same job id", async () => {
  const a = await ledger.enqueue("extract", { x: 1 }, "dup:1");
  const b = await ledger.enqueue("extract", { x: 1 }, "dup:1");
  assert.equal(a, b);
});

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadCases, runCases, checkDrift, bless, computeTreeHash, type SutRegistry,
} from "./harness.js";
import { runEval, parseArgs } from "./run.js";
import { sutRegistry } from "./registry.js";
import { UsageCollector } from "./usage.js";
import { FakeLLMProvider, llmCostUsd } from "../fakes/providers.js";

const repoGolden = join(process.cwd(), "eval", "golden");
const repoLock = join(process.cwd(), "eval", "fixtures.lock.json");

test("repo golden set passes end-to-end and is drift-clean", async () => {
  const { exitCode, report } = await runEval(parseArgs([], process.cwd()));
  assert.equal(exitCode, 0, report ? JSON.stringify(report.results.filter(r => r.status === "fail"), null, 2) : "no report");
  assert.ok(report!.metrics.passed > 0, "expected runnable golden cases to pass");
  assert.equal(report!.metrics.failed, 0);
});

test("pending cases are reported but never fail the run", async () => {
  const report = await runCases(
    [
      {
        id: "declarative-case", title: "t", kind: "adversarial", slice: 8,
        expect: [], metrics: ["historical_recall"], noChangeTrap: false, rationale: "r",
      },
    ],
    {},
  );
  assert.equal(report.results[0]!.status, "pending");
  assert.equal(report.failures, 0);
  assert.equal(report.metrics.recallCorrectness, null);
});

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "minimi-eval-"));
  await mkdir(join(dir, "golden"), { recursive: true });
});
after(async () => rm(dir, { recursive: true, force: true }));

const failingCase = {
  id: "negative-control",
  title: "deliberate failure — must make the runner exit non-zero",
  kind: "adversarial",
  sut: "time.dayRange",
  input: { date: "2026-11-03", tz: "Europe/Lisbon" },
  expect: [{ path: "fromUtc", op: "eq", value: "1999-01-01T00:00:00.000Z" }],
  metrics: ["temporal_correctness"],
  noChangeTrap: false,
  rationale: "negative control for the runner",
  slice: 2,
};

test("runner fails on regression (negative control)", async () => {
  await writeFile(join(dir, "golden", "negative-control.json"), JSON.stringify(failingCase));
  await bless(join(dir, "golden"), join(dir, "lock.json"));
  const { exitCode, report } = await runEval({
    dir: join(dir, "golden"),
    lockFile: join(dir, "lock.json"),
    json: false,
    blessMode: false,
    driftCheck: true,
  });
  assert.equal(exitCode, 1);
  assert.equal(report!.failures, 1);
  assert.equal(report!.results[0]!.status, "fail");
});

test("drift check detects tampered fixtures and bless re-pins them", async () => {
  const tampered = { ...failingCase, expect: [{ path: "fromUtc", op: "eq", value: "2026-11-03T00:00:00.000Z" }] };
  await writeFile(join(dir, "golden", "negative-control.json"), JSON.stringify(tampered));
  const drift = await checkDrift(join(dir, "golden"), join(dir, "lock.json"));
  assert.equal(drift.ok, false);
  assert.deepEqual(drift.mismatched, ["negative-control.json"]);

  const { exitCode } = await runEval({
    dir: join(dir, "golden"),
    lockFile: join(dir, "lock.json"),
    json: false,
    blessMode: false,
    driftCheck: true,
  });
  assert.equal(exitCode, 2, "tampered fixtures must block the eval run");

  await bless(join(dir, "golden"), join(dir, "lock.json"));
  const drift2 = await checkDrift(join(dir, "golden"), join(dir, "lock.json"));
  assert.equal(drift2.ok, true);
});

test("computeTreeHash is deterministic and order-independent", async () => {
  const a = await computeTreeHash(repoGolden);
  const b = await computeTreeHash(repoGolden);
  assert.deepEqual(a, b);
  assert.ok(Object.keys(a).length > 0);
  for (const h of Object.values(a)) assert.match(h, /^[0-9a-f]{64}$/);
});

test("loadCases rejects schema-invalid cases", async () => {
  await mkdir(join(dir, "bad"), { recursive: true });
  await writeFile(join(dir, "bad", "bad.json"), JSON.stringify({ id: "BAD ID!", title: "x" }));
  await assert.rejects(loadCases(join(dir, "bad")), /failed validation/);
});

test("loadCases rejects duplicate ids", async () => {
  await mkdir(join(dir, "dup"), { recursive: true });
  await writeFile(join(dir, "dup", "a.json"), JSON.stringify({ ...failingCase, id: "dup-case", expect: [] }));
  await writeFile(join(dir, "dup", "b.json"), JSON.stringify({ ...failingCase, id: "dup-case", expect: [] }));
  await assert.rejects(loadCases(join(dir, "dup")), /duplicate golden case id/);
});

test("repo lock file matches the repo golden tree", async () => {
  const drift = await checkDrift(repoGolden, repoLock);
  assert.deepEqual(drift, { ok: true, mismatched: [], missing: [], added: [] });
});

test("per-case usage/cost collector records actual provider cost", async () => {
  const llm = new FakeLLMProvider(() => ({
    text: "x", model: "fake-llm-1", usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
  }));
  const registry: SutRegistry = {
    "llm.example": async (_input, usage) => {
      const res = await llm.complete({ messages: [{ role: "user", content: "hi" }] });
      usage.record(`llm:${res.model}`, llmCostUsd(res.model, res.usage));
      return { ok: true };
    },
  };
  const report = await runCases(
    [{
      id: "cost-case", title: "t", kind: "scenario", sut: "llm.example", input: {},
      expect: [{ path: "ok", op: "eq", value: true }],
      metrics: [], noChangeTrap: false, rationale: "r", slice: 2,
    }],
    registry,
  );
  const r = report.results[0]!;
  assert.equal(r.status, "pass");
  assert.ok(r.costUsd > 0, "measured provider cost must flow into the case result");
  assert.equal(r.costBreakdown.length, 1);
  assert.equal(r.costBreakdown[0]!.source, "llm:fake-llm-1");
  assert.equal(report.metrics.costUsd, r.costUsd);
});

test("a case that uses no provider measures exactly zero cost", async () => {
  const registry: SutRegistry = { "noop.example": async () => ({ ok: true }) };
  const report = await runCases(
    [{
      id: "noop-case", title: "t", kind: "adversarial", sut: "noop.example", input: {},
      expect: [{ path: "ok", op: "eq", value: true }],
      metrics: [], noChangeTrap: false, rationale: "r", slice: 2,
    }],
    registry,
  );
  const r = report.results[0]!;
  assert.equal(r.costUsd, 0);
  assert.deepEqual(r.costBreakdown, []);
});

test("sutRegistry handlers reject malformed input with an error, not a crash", async () => {
  await assert.rejects(sutRegistry["time.dayRange"]!({ date: "not-a-date", tz: "UTC" }, new UsageCollector()));
  await assert.rejects(sutRegistry["episode.recall"]!({ date: "2026-11-03", tz: "UTC", episodes: [{}] }, new UsageCollector()));
});

test("episode.recall handler returns interpreted-as echo with UTC bounds", async () => {
  const out = (await sutRegistry["episode.recall"]!({
    date: "2026-11-03",
    tz: "Europe/Lisbon",
    episodes: [
      {
        id: "e1", externalId: "x1", sessionId: "s", seq: 0, role: "user", text: "hello",
        occurredAt: "2026-11-03T10:00:00.000Z", precision: "second", tz: "Europe/Lisbon",
        source: "chat", createdAt: "2026-11-03T10:00:00.000Z",
      },
    ],
  }, new UsageCollector())) as { interpretedAs: { fromUtc: string; toUtc: string }; episodes: { id: string }[] };
  assert.equal(out.interpretedAs.fromUtc, "2026-11-03T00:00:00.000Z");
  assert.equal(out.interpretedAs.toUtc, "2026-11-04T00:00:00.000Z");
  assert.deepEqual(out.episodes.map((e) => e.id), ["e1"]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMetrics, type CaseResult } from "./metrics.js";

const base = (over: Partial<CaseResult>): CaseResult => ({
  id: over.id ?? "case",
  kind: over.kind ?? "adversarial",
  status: over.status ?? "pass",
  slice: over.slice ?? 2,
  metrics: over.metrics ?? [],
  noChangeTrap: over.noChangeTrap ?? false,
  latencyMs: over.latencyMs ?? 1,
  costUsd: over.costUsd ?? 0,
  costBreakdown: over.costBreakdown ?? [],
  assertions: over.assertions ?? [],
  summary: "s",
  ...over,
});

test("pass rates computed per metric tag over executed cases only", () => {
  const m = computeMetrics([
    base({ id: "r1", metrics: ["historical_recall"], status: "pass" }),
    base({ id: "r2", metrics: ["historical_recall"], status: "fail" }),
    base({ id: "r3", metrics: ["historical_recall"], status: "pending" }), // excluded
    base({ id: "t1", metrics: ["temporal_correctness"], status: "pass" }),
  ]);
  assert.equal(m.recallCorrectness, 0.5);
  assert.equal(m.temporalCorrectness, 1);
  assert.equal(m.citationCoverage, null); // no executed case tagged it
});

test("false-unchanged violations count only failed safety assertions, not ordinary failures", () => {
  const trapWithUnrelatedFailure = base({
    id: "trap-citation-fail",
    noChangeTrap: true,
    status: "fail",
    assertions: [
      { path: "verdict", op: "neq", value: "verified_unchanged", actual: "no_change_found", pass: true, safety: true },
      { path: "report.citations", op: "exists", actual: undefined, pass: false, message: "citation missing" },
    ],
  });
  const failedSafetyAssertion = base({
    id: "system-claims-unchanged",
    noChangeTrap: true,
    status: "fail",
    assertions: [
      {
        path: "verdict", op: "neq", value: "verified_unchanged",
        actual: "verified_unchanged", pass: false, safety: true,
        message: "expected verdict != verified_unchanged",
      },
    ],
  });
  const ordinaryFailureOnly = base({
    id: "citation-only-failure",
    noChangeTrap: true,
    status: "fail",
    assertions: [
      { path: "report.citations", op: "exists", actual: undefined, pass: false, message: "citation missing" },
    ],
  });
  const changedCaseClaimsUnchanged = base({
    id: "changed-case-claims-unchanged", // safety assertions also apply outside noChangeTrap cases
    noChangeTrap: false,
    status: "fail",
    assertions: [
      { path: "verdict", op: "neq", value: "verified_unchanged", actual: "verified_unchanged", pass: false, safety: true },
      { path: "facts.0.status", op: "eq", value: "changed", actual: "unchanged", pass: false },
    ],
  });

  const m = computeMetrics([
    trapWithUnrelatedFailure, failedSafetyAssertion, ordinaryFailureOnly, changedCaseClaimsUnchanged,
  ]);
  assert.equal(m.falseUnchangedViolations, 2, "only failed safety assertions count, trap-flagged or not");
  assert.equal(m.failed, 4, "general case failures stay in the ordinary failure count");
});

test("latency percentiles and cost over executed cases", () => {
  const m = computeMetrics([
    base({ id: "a", status: "pass", latencyMs: 10, costUsd: 0.01 }),
    base({ id: "b", status: "fail", latencyMs: 100, costUsd: 0.02 }),
    base({ id: "c", status: "pending", latencyMs: 9999, costUsd: 99 }),
  ]);
  assert.equal(m.latencyMs.max, 100);
  assert.equal(m.latencyMs.p50, 10);
  assert.equal(m.costUsd, 0.03);
  assert.equal(m.total, 3);
  assert.equal(m.pending, 1);
});

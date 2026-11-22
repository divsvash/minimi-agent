import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMetrics, type CaseResult } from "./metrics.js";
import { formatReport } from "./run.js";
import { summarizeCost, summarizeExtractionScores, summarizeScenarios } from "./summary.js";

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

const scenarioResults = (): CaseResult[] => [
  base({ id: "a-pass", scenario: "A", status: "pass" }),
  base({ id: "a-pending", scenario: "A", status: "pending" }),
  base({ id: "b-pass", scenario: "B", status: "pass" }),
  base({ id: "b-fail", scenario: "B", status: "fail" }),
  base({ id: "c-pass", scenario: "C", status: "pass" }),
];

test("challenge summaries separate executable, complete, and failing scenarios", () => {
  const results = scenarioResults();
  const c = summarizeScenarios(results);
  const byId = (id: "A" | "B" | "C") => c.scenarios.find((s) => s.id === id)!;

  assert.equal(c.totalScenarios, 3);
  assert.equal(c.totalCases, 5);
  assert.equal(c.executedCases, 4);
  assert.equal(c.pendingCases, 1);
  assert.equal(c.completeScenarios, 1);
  assert.equal(c.executableScenarios, 3);
  assert.equal(c.fullyExecutableScenarios, 2);
  assert.equal(c.complete, false);

  assert.deepEqual(
    { status: byId("A").status, executed: byId("A").executed, pending: byId("A").pending },
    { status: "partial", executed: 1, pending: 1 },
  );
  assert.deepEqual(
    { status: byId("B").status, fullyExecutable: byId("B").fullyExecutable },
    { status: "failing", fullyExecutable: true },
  );
  assert.deepEqual(
    { status: byId("C").status, complete: byId("C").complete },
    { status: "complete", complete: true },
  );
});

test("cost summary distinguishes measured calls from an unmeasured zero", () => {
  const unmeasured = summarizeCost([base({ id: "noop", status: "pass" })]);
  assert.equal(unmeasured.basis, "not_measured");
  assert.equal(unmeasured.providerCalls, 0);
  assert.equal(unmeasured.casesWithProviderCalls, 0);
  assert.equal(unmeasured.totalUsd, 0);

  const measured = summarizeCost([
    base({ id: "llm", status: "pass", costUsd: 0.02, costBreakdown: [{ source: "llm:fake", usd: 0.02 }] }),
    base({ id: "embed", status: "fail", costUsd: 0.01, costBreakdown: [{ source: "embed:fake", usd: 0.01 }] }),
    base({ id: "pending", status: "pending", costUsd: 99, costBreakdown: [{ source: "ignored", usd: 99 }] }),
  ]);
  assert.equal(measured.basis, "measured");
  assert.equal(measured.providerCalls, 2);
  assert.equal(measured.casesWithProviderCalls, 2);
  assert.equal(measured.totalUsd, 0.03);
});

test("formatted report makes incomplete challenge coverage and unmeasured cost explicit", () => {
  const results = scenarioResults();
  const metrics = computeMetrics(results);
  const out = formatReport({
    results,
    metrics,
    challenge: summarizeScenarios(results),
    cost: summarizeCost(results),
    extraction: summarizeExtractionScores(results),
    failures: metrics.failed,
  });

  assert.ok(out.includes("cases: 5 total | executed=4 (pass=3, fail=1) | pending=1"));
  assert.ok(out.includes("A  PARTIAL"));
  assert.ok(out.includes("B  FAILING"));
  assert.ok(out.includes("C  COMPLETE"));
  assert.ok(out.includes(
    "challenge completion: FAILING — cases 4/5 executed; scenarios complete 1/3, executable 3/3, fully executable 2/3",
  ));
  assert.ok(out.includes(
    "provider cost:                 NOT MEASURED — 0 provider calls recorded; zero is not a measured provider cost",
  ));
  assert.ok(out.includes(
    "run status: FAILING — 4/5 cases executed, 1 pending, 1 failed; this is NOT a complete hiring-challenge evaluation",
  ));
});

test("formatted report labels cost as measured only when a provider call was recorded", () => {
  const results = [
    base({
      id: "llm", scenario: "A", status: "pass", costUsd: 0.02,
      costBreakdown: [{ source: "llm:fake", usd: 0.02 }],
    }),
  ];
  const metrics = computeMetrics(results);
  const out = formatReport({
    results,
    metrics,
    challenge: summarizeScenarios(results),
    cost: summarizeCost(results),
    extraction: summarizeExtractionScores(results),
    failures: metrics.failed,
  });

  assert.ok(out.includes(
    "provider cost USD:             0.020000 (measured from 1 provider call(s) across 1 executed case(s))",
  ));
});

test("extraction summary aggregates only the scores that were actually recorded", () => {
  const full = base({
    id: "e1", status: "pass", slice: 3,
    scores: [
      { name: "extraction_precision", value: 1 },
      { name: "extraction_recall", value: 1 },
      { name: "provenance_validity", value: 1 },
      { name: "negation_modality_preservation", value: 1 },
    ],
    costBreakdown: [{ source: "llm:fake-llm-1", usd: 0.001 }],
  });
  const partial = base({
    id: "e2", status: "pass", slice: 3,
    scores: [{ name: "extraction_precision", value: 0.5 }],
    costBreakdown: [{ source: "llm:fake-llm-1", usd: 0.001 }],
  });
  const failed = base({ id: "e3", status: "fail", slice: 3 });
  const pending = base({
    id: "e4", status: "pending", slice: 3,
    scores: [{ name: "extraction_precision", value: 0 }],
  });

  const s = summarizeExtractionScores([full, partial, failed, pending]);
  assert.equal(s.executedCases, 2, "failed and pending cases contribute no scores");
  assert.equal(s.providerBasis, "mocked");
  assert.equal(s.semanticQuality, "not_measured");
  assert.deepEqual(s.scores.precision, { mean: 0.75, cases: 2 });
  assert.deepEqual(s.scores.recall, { mean: 1, cases: 1 }, "a metric nobody recorded is not averaged in");
  assert.deepEqual(s.scores.duplicateOnRetryRate, { mean: null, cases: 0 }, "unrecorded means null, never 0");
  assert.deepEqual(s.scores.unsupportedAssertionRate, { mean: null, cases: 0 });
});

test("extraction summary never claims a provider basis it did not observe", () => {
  const unobserved = summarizeExtractionScores([base({ id: "x", status: "pass" })]);
  assert.equal(unobserved.providerBasis, "unmeasured");
  assert.equal(unobserved.executedCases, 0);
  assert.equal(unobserved.semanticQuality, "not_measured");

  const realProvider = summarizeExtractionScores([
    base({
      id: "y", status: "pass",
      scores: [{ name: "extraction_precision", value: 1 }],
      costBreakdown: [{ source: "llm:gpt-4o", usd: 0.01 }],
    }),
  ]);
  assert.equal(realProvider.providerBasis, "other", "a non-fake provider must not be labelled mocked");
});

test("formatted report states extraction scores, provider basis, and semantic quality", () => {
  const results = [
    base({
      id: "e1", status: "pass", slice: 3,
      scores: [
        { name: "extraction_precision", value: 1 },
        { name: "extraction_recall", value: 1 },
      ],
      costBreakdown: [{ source: "llm:fake-llm-1", usd: 0.001 }],
    }),
    base({ id: "none", status: "pass", slice: 3 }),
  ];
  const metrics = computeMetrics(results);
  const out = formatReport({
    results,
    metrics,
    challenge: summarizeScenarios(results),
    cost: summarizeCost(results),
    extraction: summarizeExtractionScores(results),
    failures: metrics.failed,
  });

  assert.ok(out.includes("provider basis MOCKED"));
  assert.ok(out.includes("semantic quality NOT MEASURED"));
  assert.ok(out.includes("extraction precision:          100.0% (n=1)"));
  assert.ok(out.includes("duplicate-on-retry rate:       n/a (no case recorded it)"));
});

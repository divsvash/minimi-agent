import type { GoldenMetric } from "./goldenCase.js";
import type { AssertionResult } from "./matchers.js";

export type CaseStatus = "pass" | "fail" | "pending";

export interface CaseResult {
  id: string;
  scenario?: "A" | "B" | "C";
  kind: "scenario" | "adversarial";
  status: CaseStatus;
  slice: number;
  metrics: GoldenMetric[];
  noChangeTrap: boolean;
  latencyMs: number;
  costUsd: number;
  assertions: AssertionResult[];
  /** Set when the SUT threw instead of returning output. */
  error?: string;
  /** Short human-readable summary for failure output. */
  summary: string;
}

export interface LatencyStats { p50: number; p95: number; max: number }

export interface EvalMetrics {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  /** Fraction of EXECUTED cases tagged historical_recall that pass; null if none executed. */
  recallCorrectness: number | null;
  /** Fraction of EXECUTED cases tagged temporal_correctness that pass; null if none executed. */
  temporalCorrectness: number | null;
  /** Fraction of EXECUTED cases tagged citation_coverage that pass; null if none executed. */
  citationCoverage: number | null;
  /** Count of executed no-change-trap cases that failed — target is ALWAYS 0 (§6.4, ADR-009). */
  falseUnchangedViolations: number;
  /** Executed (non-pending) cases' latency distribution. */
  latencyMs: LatencyStats;
  /** Total provider cost across executed cases. */
  costUsd: number;
}

function pctl(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length) - 1;
  return sortedAsc[Math.min(Math.max(rank, 0), sortedAsc.length - 1)]!;
}

function passRate(results: CaseResult[], tag: GoldenMetric): number | null {
  const executed = results.filter((r) => r.status !== "pending" && r.metrics.includes(tag));
  if (executed.length === 0) return null;
  return executed.filter((r) => r.status === "pass").length / executed.length;
}

export function computeMetrics(results: CaseResult[]): EvalMetrics {
  const executed = results.filter((r) => r.status !== "pending");
  const latencies = executed.map((r) => r.latencyMs).sort((a, b) => a - b);
  return {
    total: results.length,
    passed: results.filter((r) => r.status === "pass").length,
    failed: results.filter((r) => r.status === "fail").length,
    pending: results.filter((r) => r.status === "pending").length,
    recallCorrectness: passRate(results, "historical_recall"),
    temporalCorrectness: passRate(results, "temporal_correctness"),
    citationCoverage: passRate(results, "citation_coverage"),
    falseUnchangedViolations: executed.filter((r) => r.noChangeTrap && r.status === "fail").length,
    latencyMs: {
      p50: pctl(latencies, 50),
      p95: pctl(latencies, 95),
      max: latencies.at(-1) ?? 0,
    },
    costUsd: executed.reduce((sum, r) => sum + r.costUsd, 0),
  };
}

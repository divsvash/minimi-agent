import type { GoldenMetric } from "./goldenCase.js";
import type { AssertionResult } from "./matchers.js";

/**
 * A false-unchanged violation is a failed assertion explicitly marked `safety: true`.
 * Ordinary failures — a missing citation, a bad source list, a formatting mismatch —
 * remain ordinary case failures and are counted by `failed`, never here.
 *
 * Making the safety assertion explicit (rather than inferring it from a path/value
 * heuristic) keeps the two measurements independent and lets a case state the exact
 * safety property it is enforcing.
 */
export function failedSafetyAssertion(a: AssertionResult): boolean {
  return !a.pass && a.safety === true;
}

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
  /** Which providers the case actually used, and what they cost. Empty = no provider was used. */
  costBreakdown: readonly { source: string; usd: number }[];
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
  /**
   * Count of executed cases with at least one failed assertion marked `safety: true`.
   * These are the explicit false-unchanged safety gates; ordinary failures (citations,
   * sources, formatting) do not increment this. Target for the whole suite is ALWAYS 0
   * (§6.4, ADR-009).
   */
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
    falseUnchangedViolations: executed.filter((r) => r.assertions.some(failedSafetyAssertion)).length,
    latencyMs: {
      p50: pctl(latencies, 50),
      p95: pctl(latencies, 95),
      max: latencies.at(-1) ?? 0,
    },
    costUsd: executed.reduce((sum, r) => sum + r.costUsd, 0),
  };
}

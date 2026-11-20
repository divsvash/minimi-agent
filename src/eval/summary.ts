import type { CaseResult } from "./metrics.js";

export const SCENARIO_IDS = ["A", "B", "C"] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

/**
 * - `complete`: every case in the scenario ran and passed.
 * - `failing`: at least one case ran and failed.
 * - `partial`: some cases ran, none failed, but some remain pending.
 * - `not_executable`: no SUT is registered for any case in the scenario.
 */
export type ScenarioStatus = "complete" | "failing" | "partial" | "not_executable";

export interface ScenarioSummary {
  id: ScenarioId;
  total: number;
  executed: number;
  passed: number;
  failed: number;
  pending: number;
  /** At least one case actually ran. */
  executable: boolean;
  /** Every case in the scenario actually ran. */
  fullyExecutable: boolean;
  /** Every case ran and passed. */
  complete: boolean;
  status: ScenarioStatus;
}

export interface ChallengeSummary {
  scenarios: ScenarioSummary[];
  totalScenarios: number;
  completeScenarios: number;
  /** Scenarios with at least one executed case. */
  executableScenarios: number;
  /** Scenarios whose every case executed. */
  fullyExecutableScenarios: number;
  totalCases: number;
  executedCases: number;
  passedCases: number;
  failedCases: number;
  pendingCases: number;
  /** True only when all A/B/C scenarios are fully executed and passing. */
  complete: boolean;
}

export type CostBasis = "measured" | "not_measured";

export interface CostSummary {
  /** Sum of recorded provider costs across executed cases. */
  totalUsd: number;
  /** Number of provider usage entries recorded by executed cases. */
  providerCalls: number;
  /** Executed cases that recorded at least one provider usage entry. */
  casesWithProviderCalls: number;
  /** `measured` only when at least one provider call was recorded; `not_measured` otherwise. */
  basis: CostBasis;
}

export function summarizeScenarios(results: CaseResult[]): ChallengeSummary {
  const scenarios = SCENARIO_IDS.map((id): ScenarioSummary => {
    const cases = results.filter((r) => r.scenario === id);
    const total = cases.length;
    const passed = cases.filter((r) => r.status === "pass").length;
    const failed = cases.filter((r) => r.status === "fail").length;
    const pending = cases.filter((r) => r.status === "pending").length;
    const executed = passed + failed;
    const status: ScenarioStatus =
      executed === 0
        ? "not_executable"
        : failed > 0
          ? "failing"
          : executed === total
            ? "complete"
            : "partial";
    return {
      id,
      total,
      executed,
      passed,
      failed,
      pending,
      executable: executed > 0,
      fullyExecutable: total > 0 && executed === total,
      complete: status === "complete",
      status,
    };
  });

  const totalCases = scenarios.reduce((n, s) => n + s.total, 0);
  const executedCases = scenarios.reduce((n, s) => n + s.executed, 0);
  const passedCases = scenarios.reduce((n, s) => n + s.passed, 0);
  const failedCases = scenarios.reduce((n, s) => n + s.failed, 0);
  const completeScenarios = scenarios.filter((s) => s.complete).length;
  const executableScenarios = scenarios.filter((s) => s.executable).length;
  const fullyExecutableScenarios = scenarios.filter((s) => s.fullyExecutable).length;

  return {
    scenarios,
    totalScenarios: scenarios.length,
    completeScenarios,
    executableScenarios,
    fullyExecutableScenarios,
    totalCases,
    executedCases,
    passedCases,
    failedCases,
    pendingCases: totalCases - executedCases,
    complete: completeScenarios === scenarios.length,
  };
}

export function summarizeCost(results: CaseResult[]): CostSummary {
  const executed = results.filter((r) => r.status !== "pending");
  const providerCalls = executed.reduce((n, r) => n + r.costBreakdown.length, 0);
  const casesWithProviderCalls = executed.filter((r) => r.costBreakdown.length > 0).length;
  return {
    totalUsd: executed.reduce((n, r) => n + r.costUsd, 0),
    providerCalls,
    casesWithProviderCalls,
    basis: providerCalls > 0 ? "measured" : "not_measured",
  };
}

export const EXTRACTION_SCORE_NAMES = {
  precision: "extraction_precision",
  recall: "extraction_recall",
  provenance: "provenance_validity",
  negationModality: "negation_modality_preservation",
  unsupportedAssertionRate: "unsupported_assertion_rate",
  duplicateOnRetryRate: "duplicate_on_retry_rate",
} as const;

export interface AggregatedScore {
  /** Mean across executed cases that recorded this score; null when none did. */
  mean: number | null;
  cases: number;
}

export interface ExtractionSummary {
  executedCases: number;
  /** `mocked` when every recorded provider call came from a fake provider. */
  providerBasis: "mocked" | "unmeasured" | "other";
  /** Slice 3 has no real-provider extraction run; never claim semantic quality. */
  semanticQuality: "not_measured";
  scores: Record<keyof typeof EXTRACTION_SCORE_NAMES, AggregatedScore>;
}

function aggregate(results: CaseResult[], name: string): AggregatedScore {
  const values = results.flatMap((r) => (r.scores ?? []).filter((s) => s.name === name).map((s) => s.value));
  return {
    mean: values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length,
    cases: values.length,
  };
}

export function summarizeExtractionScores(results: CaseResult[]): ExtractionSummary {
  const executed = results.filter((r) => r.status !== "pending");
  const scoredCases = executed.filter((r) => (r.scores ?? []).length > 0);
  const sources = scoredCases.flatMap((r) => r.costBreakdown.map((c) => c.source));
  const providerBasis = sources.length === 0
    ? "unmeasured"
    : sources.every((s) => /fake/i.test(s)) ? "mocked" : "other";
  return {
    executedCases: scoredCases.length,
    providerBasis,
    semanticQuality: "not_measured",
    scores: {
      precision: aggregate(executed, EXTRACTION_SCORE_NAMES.precision),
      recall: aggregate(executed, EXTRACTION_SCORE_NAMES.recall),
      provenance: aggregate(executed, EXTRACTION_SCORE_NAMES.provenance),
      negationModality: aggregate(executed, EXTRACTION_SCORE_NAMES.negationModality),
      unsupportedAssertionRate: aggregate(executed, EXTRACTION_SCORE_NAMES.unsupportedAssertionRate),
      duplicateOnRetryRate: aggregate(executed, EXTRACTION_SCORE_NAMES.duplicateOnRetryRate),
    },
  };
}

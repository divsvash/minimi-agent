import { z } from "zod";

export const GoldenMetricSchema = z.enum([
  "historical_recall",
  "temporal_correctness",
  "citation_coverage",
  "false_unchanged",
  // Slice 3 extraction coverage tags. The measured values live in
  // EvalReport.extraction (per-case scores aggregated as means); these tags
  // record which property a case is responsible for.
  "extraction_precision",
  "extraction_recall",
  "span_validity",
  "negation_modality",
  "unsupported_assertion",
  "idempotent_retry",
]);
export type GoldenMetric = z.infer<typeof GoldenMetricSchema>;

export const GoldenAssertionSchema = z.object({
  /** Dot path into the SUT output, e.g. "interpretedAs.fromUtc" or "episodes.0.text". */
  path: z.string().min(1),
  op: z.enum(["eq", "neq", "oneOf", "includes", "length", "gte", "lte", "exists"]),
  value: z.unknown().optional(),
  description: z.string().optional(),
  /**
   * Marks the assertion that encodes a safety property (for example, "must not
   * claim verified_unchanged"). A failure is counted as a false-unchanged safety
   * violation, separately from ordinary case failures. Every noChangeTrap case
   * must declare at least one.
   */
  safety: z.boolean().optional(),
});
export type GoldenAssertion = z.infer<typeof GoldenAssertionSchema>;

export const GoldenCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1),
  /** Hiring-challenge scenario this case anchors to; omitted for pure temporal/boundary cases. */
  scenario: z.enum(["A", "B", "C"]).optional(),
  kind: z.enum(["scenario", "adversarial"]),
  question: z.string().optional(),
  /**
   * Name of a registered system-under-test handler. Absent ⇒ the case is declarative
   * for a future slice: it is validated and drift-checked, but reported as `pending`
   * (never as a failure, never in metrics denominators).
   */
  sut: z.string().min(1).optional(),
  /** SUT input (validated by the handler). */
  input: z.record(z.unknown()).optional(),
  expect: z.array(GoldenAssertionSchema).default([]),
  metrics: z.array(GoldenMetricSchema).default([]),
  /**
   * Trap for "false claims of unchanged information": any answer asserting
   * verified_unchanged here is a safety failure, counted separately.
   */
  noChangeTrap: z.boolean().default(false),
  /** Why this case exists — shown in failure output. */
  rationale: z.string().min(1),
  /** Slice in which the SUT becomes runnable. */
  slice: z.number().int().min(2).max(11),
});
export type GoldenCase = z.infer<typeof GoldenCaseSchema>;

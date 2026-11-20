/**
 * Data contracts — zod schemas ("code twins" of docs/architecture.md §3).
 * These are the authoritative wire/storage shapes for Slice 2+. Slice 1's
 * Neo4j-backed props types are intentionally untouched; convergence happens
 * per-slice, not by rewriting shipped code.
 *
 * Conventions: datetimes are ISO-8601 UTC strings on the wire; `null` is used
 * (never undefined-omission) for genuinely absent optional temporal fields so
 * "unknown valid-time start" is representable and distinguishable from "not
 * provided by this source".
 */
import { z } from "zod";

const isoDateTime = z.string().datetime({ offset: false });
const nullableIso = z.string().datetime({ offset: false }).nullable();

export const RoleSchema = z.enum(["user", "assistant", "system", "tool"]);
export const EpisodeSourceSchema = z.enum(["chat", "api", "import"]);
export const EpisodePrecisionSchema = z.enum(["second", "minute", "day", "month", "year", "unknown"]);
export const EntityTypeSchema = z.enum(["person", "org", "product", "concept", "place", "event", "team"]);
export const EntityStatusSchema = z.enum(["active", "merged", "contested", "split"]);
export const PolaritySchema = z.enum(["positive", "negative"]);
export const ModalitySchema = z.enum([
  "asserted", "considered", "shortlisted", "rejected", "uncertain", "proposed", "decided",
  "preferred", "hypothetical", "questioned",
]);
export const DecisionStatusSchema = z.enum(["proposed", "accepted", "rejected", "undecided"]);
export const StatementCategorySchema = z.enum([
  "fact", "preference", "recommendation", "decision", "constraint", "question", "hypothesis", "event",
]);
export const EpistemicStatusSchema = z.enum([
  "user_asserted", "model_inferred", "externally_verified", "user_corrected",
]);
export const AssertedBySchema = z.enum(["user", "assistant", "extraction", "external_verification"]);
export const ValiditySchema = z.enum(["bounded", "open_ended", "ongoing"]);
export const StatementStatusSchema = z.enum(["active", "superseded", "retracted", "contested"]);
export const EvidenceKindSchema = z.enum(["episode_span", "external_url", "document"]);
export const CaptureOutcomeSchema = z.enum(["ok", "http_error", "timeout", "parse_error", "blocked"]);
export const ExtractionMethodSchema = z.enum(["api", "selector", "structured_llm", "manual"]);
export const JobStatusSchema = z.enum(["pending", "running", "completed", "dead"]);

export const EpisodeSchema = z.object({
  id: z.string().min(1),
  /** Identity contract: sha256("msg|sessionId|messageId") or content-addressed fallback. */
  externalId: z.string().min(1),
  sessionId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  role: RoleSchema,
  text: z.string(),
  occurredAt: isoDateTime,
  precision: EpisodePrecisionSchema,
  tz: z.string().min(1),
  source: EpisodeSourceSchema,
  createdAt: isoDateTime,
});
export type Episode = z.infer<typeof EpisodeSchema>;
export type EpisodeRole = z.infer<typeof RoleSchema>;
export type EpisodePrecision = z.infer<typeof EpisodePrecisionSchema>;

export const EntitySchema = z.object({
  id: z.string().min(1),
  type: EntityTypeSchema,
  canonicalName: z.string().min(1),
  aliases: z.array(z.string()),
  externalIds: z.record(z.string()).optional(),
  status: EntityStatusSchema,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type Entity = z.infer<typeof EntitySchema>;
export type EntityType = z.infer<typeof EntityTypeSchema>;

export const StatementSchema = z
  .object({
    id: z.string().min(1),
    subjectId: z.string().min(1),
    predicate: z.string().min(1),
    predicateQualifier: z.record(z.string()).optional(),
    objectKind: z.enum(["entity", "literal"]),
    objectId: z.string().min(1).optional(),
    objectValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
    polarity: PolaritySchema,
    modality: ModalitySchema,
    assertedBy: AssertedBySchema,
    epistemicStatus: EpistemicStatusSchema,
    /** Extraction confidence only — never a truth score, never averaged (ADR-003). */
    confidence: z.number().min(0).max(1),
    extractionModel: z.string().optional(),
    extractionPromptHash: z.string().optional(),
    /** null = unknown valid-time start (never epoch, never "now"). */
    validFrom: nullableIso,
    validTo: nullableIso,
    timePrecision: EpisodePrecisionSchema,
    validity: ValiditySchema,
    recordedAt: isoDateTime,
    /** Rebuildable projection of the lifecycle event log — never authoritative (ADR-004). */
    status: StatementStatusSchema.optional(),
  })
  .superRefine((s, ctx) => {
    if (s.objectKind === "entity" && s.objectId === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["objectId"], message: "objectKind 'entity' requires objectId" });
    }
    if (s.objectKind === "literal" && s.objectValue === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["objectValue"], message: "objectKind 'literal' requires objectValue" });
    }
    if (s.validFrom !== null && s.validTo !== null && s.validTo < s.validFrom) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["validTo"], message: "validTo precedes validFrom" });
    }
  });
export type Statement = z.infer<typeof StatementSchema>;
export type Modality = z.infer<typeof ModalitySchema>;

export const ObservationSchema = z.object({
  id: z.string().min(1),
  /** sha256 over canonical subject|attribute|dims|url|dates|value (obs-norm/1, §9). */
  obsKey: z.string().min(1),
  attribute: z.string().min(1),
  dimensions: z.record(z.string()),
  value: z.union([z.string(), z.number(), z.boolean()]),
  unit: z.string().optional(),
  /** Three distinct axes — never conflated (§3.5). */
  sourceEffectiveAt: nullableIso,
  sourcePublishedAt: nullableIso,
  recordedAt: isoDateTime,
  source: z.object({
    url: z.string().url(),
    title: z.string(),
    publisher: z.string(),
    publishedAt: nullableIso.optional(),
    accessedAt: isoDateTime,
  }),
  extractionMethod: ExtractionMethodSchema,
  extractionConfidence: z.number().min(0).max(1),
  obsNormVersion: z.literal(1),
});
export type Observation = z.infer<typeof ObservationSchema>;

export const EvidenceSchema = z
  .object({
    id: z.string().min(1),
    kind: EvidenceKindSchema,
    episodeId: z.string().min(1).optional(),
    messageExternalId: z.string().min(1).optional(),
    /** UTF-16 code units into Episode.text (documented convention). */
    spanStart: z.number().int().nonnegative().optional(),
    spanEnd: z.number().int().nonnegative().optional(),
    quote: z.string().optional(),
    url: z.string().url().optional(),
    accessedAt: isoDateTime.optional(),
    captureId: z.string().min(1).optional(),
  })
  .superRefine((e, ctx) => {
    if (e.kind === "episode_span" && e.episodeId === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["episodeId"], message: "episode_span evidence requires episodeId" });
    }
    if (e.kind === "external_url" && e.url === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "external_url evidence requires url" });
    }
    if (e.spanStart !== undefined && e.spanEnd !== undefined && e.spanEnd < e.spanStart) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["spanEnd"], message: "spanEnd precedes spanStart" });
    }
  });
export type Evidence = z.infer<typeof EvidenceSchema>;

export const CaptureSchema = z
  .object({
    id: z.string().min(1),
    fetchedAt: isoDateTime,
    sourceUrl: z.string().url(),
    outcome: CaptureOutcomeSchema,
    httpStatus: z.number().int().optional(),
    errorKind: z.string().optional(),
    bodyHash: z.string().optional(),
    extractedFieldHashes: z.record(z.string()).optional(),
    jobId: z.string().min(1),
  })
  .superRefine((c, ctx) => {
    if (c.outcome === "ok" && c.bodyHash === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["bodyHash"], message: "outcome 'ok' requires bodyHash" });
    }
  });
export type Capture = z.infer<typeof CaptureSchema>;

export const JobSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  idempotencyKey: z.string().min(1),
  payloadJson: z.string(),
  status: JobStatusSchema,
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  /** Monotonic fencing token — checked in the same transaction as every durable output (ADR-010). */
  claimGeneration: z.number().int().nonnegative(),
  workerId: z.string().nullable(),
  leaseUntil: nullableIso,
  nextRunAt: nullableIso,
  lastError: z.string().nullable(),
  createdAt: isoDateTime.optional(),
});
export type Job = z.infer<typeof JobSchema>;

/* ------------------------------------------------------------------ *
 * Slice 3: extraction candidates (untrusted model output -> validated)
 * ------------------------------------------------------------------ */

export const CandidateEntityMentionSchema = z.object({
  name: z.string().min(1).max(200),
  type: EntityTypeSchema.optional(),
});

export const CandidateObjectSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("entity"),
    name: z.string().min(1).max(200),
    type: EntityTypeSchema.optional(),
  }),
  z.object({
    kind: z.literal("literal"),
    value: z.union([z.string().min(1), z.number(), z.boolean()]),
  }),
]);

export const CandidateEvidenceSchema = z.object({
  /** Must be an exact substring of Episode.text at [spanStart, spanEnd). */
  quote: z.string().min(1).max(4000),
  /** UTF-16 code units, matching the Evidence contract. */
  spanStart: z.number().int().nonnegative(),
  spanEnd: z.number().int().nonnegative(),
});

export const CandidateTemporalSchema = z.object({
  /** The temporal words as stated in the episode, never a normalized replacement. */
  expression: z.string().min(1).nullable().optional(),
  /** Only set when the episode timestamp/context justifies the resolution. */
  validFrom: nullableIso.optional(),
  validTo: nullableIso.optional(),
  timePrecision: EpisodePrecisionSchema.optional(),
  validity: ValiditySchema.optional(),
});

export const CandidateStatementSchema = z.object({
  subject: CandidateEntityMentionSchema,
  predicate: z.string().min(1).max(80),
  object: CandidateObjectSchema,
  polarity: PolaritySchema,
  modality: ModalitySchema,
  decisionStatus: DecisionStatusSchema.nullable().optional(),
  category: StatementCategorySchema.optional(),
  /** Extraction confidence only — never a truth score (ADR-003). */
  confidence: z.number().min(0).max(1).default(0.5),
  temporal: CandidateTemporalSchema.optional(),
  scope: z.record(z.string()).optional(),
  qualifications: z.array(z.string().min(1)).max(20).optional(),
  evidence: CandidateEvidenceSchema,
});
export type CandidateStatement = z.infer<typeof CandidateStatementSchema>;

export const ExtractResultSchema = z.object({
  candidates: z.array(CandidateStatementSchema).max(32),
});
export type ExtractResult = z.infer<typeof ExtractResultSchema>;

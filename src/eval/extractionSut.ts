import { z } from "zod";
import { fixedClock } from "../core/clock.js";
import {
  DecisionStatusSchema, EpisodeSchema, ModalitySchema, PolaritySchema,
  type CandidateStatement, type Episode,
} from "../contracts/schemas.js";
import { ExtractionService, type ExtractionResult } from "../extraction/extractEpisode.js";
import { ExtractionJobHandler } from "../extraction/extractionJobHandler.js";
import { normalizeMention, normalizePredicate } from "../extraction/validate.js";
import { InMemoryJobLedger } from "../fakes/memoryJobLedger.js";
import { InMemoryStatementStore } from "../fakes/memoryStatementStore.js";
import { FAKE_LLM_PRICE, FakeLLMProvider, llmCostUsd } from "../fakes/providers.js";
import { JobWorker } from "../jobs/worker.js";
import type { SutHandler } from "./harness.js";
import { EXTRACTION_SCORE_NAMES } from "./summary.js";

/**
 * Slice 3 system-under-test: episode -> provider -> validated candidates ->
 * fenced job commit -> persisted statements.
 *
 * It runs the REAL `JobWorker`, `ExtractionJobHandler`, `ExtractionService` and
 * `InMemoryStatementStore`. Only two things are substituted: the LLM provider
 * (deterministic fake, no network) and the job ledger (offline fence twin).
 *
 * HONESTY LABELS carried in every output:
 *   provider: "fake-llm-1"     — mocked provider, no real model was called
 *   semanticQuality: "not_measured" — mocked scripts cannot measure whether the
 *                     extracted meaning is correct; only span/provenance/label
 *                     agreement is measured here.
 */

const LabelSchema = z.object({
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string(),
  polarity: PolaritySchema,
  modality: ModalitySchema,
  decisionStatus: DecisionStatusSchema.nullable().optional(),
});
type Label = z.infer<typeof LabelSchema>;

const ExtractionInput = z.object({
  episode: EpisodeSchema,
  /** Scripted provider responses, consumed in order across calls. */
  responses: z.array(z.string()).min(1),
  /** Gold labels for precision/recall. Empty ⇒ the case measures nothing semantic. */
  labels: z.array(LabelSchema).default([]),
  /** Separate extractions of the same episode (idempotent-reprocessing probe). */
  runs: z.number().int().min(1).max(4).default(1),
  /** Lose the job fence before the first durable write. */
  staleFence: z.boolean().default(false),
  providerFailures: z
    .object({
      timeout: z.number().int().min(0).default(0),
      unavailable: z.number().int().min(0).default(0),
      error: z.number().int().min(0).default(0),
    })
    .default({ timeout: 0, unavailable: 0, error: 0 }),
  /** Total provider attempts inside ONE extraction (retry-on-retryable). */
  maxProviderAttempts: z.number().int().min(1).max(4).default(2),
});

type SignatureInput = {
  subject: string;
  predicate: string;
  object: string;
  polarity: string;
  modality: string;
  decisionStatus?: string | null;
};

/** Label-comparison key. Both sides are normalized identically. */
function signature(x: SignatureInput): string {
  return [
    normalizeMention(x.subject).toLocaleLowerCase(),
    normalizePredicate(x.predicate),
    normalizeMention(x.object).toLocaleLowerCase(),
    x.polarity,
    x.modality,
    x.decisionStatus ?? "",
  ].join("|");
}

function fromCandidate(c: CandidateStatement): SignatureInput {
  return {
    subject: c.subject.name,
    predicate: c.predicate,
    object: c.object.kind === "entity" ? c.object.name : String(c.object.value),
    polarity: c.polarity,
    modality: c.modality,
    decisionStatus: c.decisionStatus ?? null,
  };
}

/** Captures each successful extraction so the eval can score what was accepted. */
class CapturingExtractionService extends ExtractionService {
  last: ExtractionResult | null = null;
  totalProviderCalls = 0;

  async extractEpisode(episode: Episode): Promise<ExtractionResult> {
    const result = await super.extractEpisode(episode);
    this.last = result;
    this.totalProviderCalls += result.providerCalls;
    return result;
  }
}

function spanIsExact(
  episode: Episode,
  spanStart: number | undefined,
  spanEnd: number | undefined,
  quote: string | undefined,
): boolean {
  if (typeof spanStart !== "number" || typeof spanEnd !== "number" || quote === undefined) return false;
  if (spanStart < 0 || spanEnd <= spanStart || spanEnd > episode.text.length) return false;
  return episode.text.slice(spanStart, spanEnd) === quote;
}

export const extractionEpisodeHandler: SutHandler = async (input, usage, scores) => {
  const { episode, responses, labels, runs, staleFence, providerFailures, maxProviderAttempts } =
    ExtractionInput.parse(input);

  let callIndex = 0;
  const provider = new FakeLLMProvider(() => {
    const text = responses[Math.min(callIndex, responses.length - 1)]!;
    callIndex += 1;
    const res = {
      text,
      model: FAKE_LLM_PRICE.model,
      usage: { inputTokens: 1_500, outputTokens: 500 },
      finishReason: "stop",
    };
    usage.record(`llm:${res.model}`, llmCostUsd(res.model, res.usage));
    return res;
  });
  if (providerFailures.timeout > 0) provider.timeoutNext(providerFailures.timeout);
  if (providerFailures.unavailable > 0) provider.unavailableNext(providerFailures.unavailable);
  if (providerFailures.error > 0) provider.failNext(providerFailures.error);

  const store = new InMemoryStatementStore();
  const extractor = new CapturingExtractionService({
    provider,
    timeoutMs: 0, // the fake never blocks; no local deadline needed offline
    maxProviderAttempts,
    clock: fixedClock(new Date("2026-11-19T00:00:00.000Z")),
  });
  const ledger = new InMemoryJobLedger();
  const handler = new ExtractionJobHandler<object>({
    episodes: { byId: async (id) => (id === episode.id ? episode : null) },
    extractor,
    statements: store,
  });
  const worker = new JobWorker<object>(ledger, [handler], {
    workerId: "eval-worker",
    leaseRenewMs: 0, // heartbeat off: each offline job is a single synchronous step
    idleDelayMs: 0,
  });

  // One job per run ⇒ "reprocessing" is a genuine second claim of the same episode.
  for (let run = 0; run < runs; run++) {
    ledger.enqueue("extract", { episodeId: episode.id }, `extract:${episode.id}:run:${run}`, { maxAttempts: 1 });
  }
  if (staleFence) ledger.failNextFence(1);

  const outcomes: string[] = [];
  let firstRunAccepted: CandidateStatement[] | null = null;
  let statementCountAfterFirst = 0;
  for (let run = 0; run < runs; run++) {
    const outcome = await worker.runOnce();
    outcomes.push(outcome);
    if (outcome === "completed" && firstRunAccepted === null) {
      firstRunAccepted = extractor.last?.acceptedCandidates ?? [];
      statementCountAfterFirst = store.size;
    }
  }

  const statements = store.allStatements();
  const allEvidence = store.allEvidence();
  const entities = store.allEntities();
  const recordedErrors = ledger
    .jobs()
    .map((j) => j.lastError)
    .filter((e): e is string => e !== null);
  const lastError = recordedErrors.at(-1) ?? null;
  const status = lastError !== null ? "failed" : outcomes.includes("stale") ? "fenced_out" : "ok";

  const accepted = firstRunAccepted ?? [];
  const labelSignatures = new Set(labels.map((l) => signature(l)));
  const matched = accepted.filter((c) => labelSignatures.has(signature(fromCandidate(c)))).length;
  const precision = accepted.length === 0 ? 1 : matched / accepted.length;
  const recall = labels.length === 0 ? 1 : matched / labels.length;

  // Provenance is measured on what was PERSISTED, not on what the extractor returned.
  const provenancePassing = statements.filter((s) => {
    const evs = store.evidenceFor(s.id);
    if (evs.length === 0) return false;
    if (!store.entitiesFor(s.id).some((e) => e.id === s.subjectId)) return false;
    if (s.objectKind === "entity" && (!s.objectId || !store.entitiesFor(s.id).some((e) => e.id === s.objectId))) {
      return false;
    }
    return evs.every(
      (ev) =>
        ev.kind === "episode_span" &&
        ev.episodeId === episode.id &&
        spanIsExact(episode, ev.spanStart, ev.spanEnd, ev.quote),
    );
  }).length;
  const provenanceValidity = statements.length === 0 ? 1 : provenancePassing / statements.length;

  const salient = labels.filter((l) => l.polarity === "negative" || l.modality !== "asserted");
  const preserved = salient.filter((l) =>
    accepted.some((c) => signature(fromCandidate(c)) === signature(l)),
  ).length;
  const negationModalityPreservation = salient.length === 0 ? 1 : preserved / salient.length;

  const committing = accepted.filter((c) => c.modality === "asserted" || c.modality === "decided");
  const unsupported = committing.filter((c) => !labelSignatures.has(signature(fromCandidate(c)))).length;
  const unsupportedAssertionRate = committing.length === 0 ? 0 : unsupported / committing.length;

  const statementCountAfterRetry = store.size;
  const duplicateOnRetryRate =
    statementCountAfterFirst > 0
      ? Math.max(0, (statementCountAfterRetry - statementCountAfterFirst) / statementCountAfterFirst)
      : 0;

  // Scores are recorded only for a run that actually completed, and only when
  // the metric has a real denominator. A failed or fenced-out run produced
  // nothing to score; a metric whose precondition did not occur (no persisted
  // statement, no negative/qualified label, no committing statement, no second
  // run) is NOT recorded — reporting 0 or 1 there would be a measured value for
  // something that was never measured.
  if (firstRunAccepted !== null) {
    scores.record(EXTRACTION_SCORE_NAMES.precision, precision);
    scores.record(EXTRACTION_SCORE_NAMES.recall, recall);
    if (statements.length > 0) {
      scores.record(EXTRACTION_SCORE_NAMES.provenance, provenanceValidity);
    }
    if (salient.length > 0) {
      scores.record(EXTRACTION_SCORE_NAMES.negationModality, negationModalityPreservation);
    }
    if (committing.length > 0) {
      scores.record(EXTRACTION_SCORE_NAMES.unsupportedAssertionRate, unsupportedAssertionRate);
    }
    if (runs >= 2 && statementCountAfterFirst > 0) {
      scores.record(EXTRACTION_SCORE_NAMES.duplicateOnRetryRate, duplicateOnRetryRate);
    }
  }

  return {
    status,
    provider: FAKE_LLM_PRICE.model,
    semanticQuality: "not_measured",
    error: lastError,
    outcomes,
    counts: {
      labels: labels.length,
      statements: statements.length,
      evidence: allEvidence.length,
      entities: entities.length,
      accepted: accepted.length,
      duplicates: extractor.last?.duplicateCandidates ?? 0,
      providerCalls: extractor.totalProviderCalls,
    },
    statements: statements.map((s) => ({
      id: s.id,
      subjectId: s.subjectId,
      predicate: s.predicate,
      predicateQualifier: s.predicateQualifier ?? {},
      objectKind: s.objectKind,
      objectId: s.objectId ?? null,
      objectValue: s.objectValue ?? null,
      polarity: s.polarity,
      modality: s.modality,
      epistemicStatus: s.epistemicStatus,
      validFrom: s.validFrom,
      timePrecision: s.timePrecision,
      validity: s.validity,
      evidence: store.evidenceFor(s.id).map((ev) => ({
        spanStart: ev.spanStart ?? null,
        spanEnd: ev.spanEnd ?? null,
        quote: ev.quote ?? null,
        exact: spanIsExact(episode, ev.spanStart, ev.spanEnd, ev.quote),
      })),
    })),
    evidence: allEvidence.map((ev) => ({
      id: ev.id,
      episodeId: ev.episodeId ?? null,
      spanStart: ev.spanStart ?? null,
      spanEnd: ev.spanEnd ?? null,
      quote: ev.quote ?? null,
      exact: spanIsExact(episode, ev.spanStart, ev.spanEnd, ev.quote),
    })),
    scores: {
      // Mirrors exactly what was recorded above: a metric with no applicable
      // denominator is null here, never a 0 or 1 we did not measure.
      precision: firstRunAccepted !== null ? precision : null,
      recall: firstRunAccepted !== null ? recall : null,
      provenanceValidity: firstRunAccepted !== null && statements.length > 0 ? provenanceValidity : null,
      negationModalityPreservation: firstRunAccepted !== null && salient.length > 0
        ? negationModalityPreservation
        : null,
      unsupportedAssertionRate: firstRunAccepted !== null && committing.length > 0
        ? unsupportedAssertionRate
        : null,
      duplicateOnRetryRate: runs >= 2 && statementCountAfterFirst > 0 ? duplicateOnRetryRate : null,
    },
  };
};

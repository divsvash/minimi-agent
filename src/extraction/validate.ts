import { ids } from "../core/ids.js";
import type {
  CandidateStatement, Entity, Episode, Evidence, Statement,
} from "../contracts/schemas.js";
import type { StatementWrite } from "../contracts/ports.js";

/** Bump when the candidate contract or validation semantics change. */
export const EXTRACTION_SCHEMA_VERSION = "candidate/1";

/**
 * Deliberately small, closed vocabulary of normalized predicates the extractor
 * may persist. This is a provenance boundary, not semantic entailment: it keeps
 * arbitrary model-invented relationships out of memory without a web of regexes.
 * Extend only by editing this set deliberately (together with the prompt).
 */
export const EXTRACTION_PREDICATES = new Set([
  // grounded actions and decisions
  "adopt", "choose", "decide", "go_with", "migrate_to", "reject", "select", "shortlist", "shortlisted", "use",
  // preferences and evaluations
  "compare", "consider", "evaluate", "is", "is_too_expensive", "prefer", "recommend",
  // capabilities and state
  "has", "have", "require", "support",
  // the explicit question meta-form permitted by the extraction prompt
  "asked_about",
  // modality-decorated forms that occur verbatim in grounded text
  "must_not_use", "should_use",
]);

export const RESERVED_QUALIFIER_KEYS = new Set([
  "statementType",
  "decisionStatus",
  "temporalExpression",
  "qualifications",
  "extractionStatus",
  "extractionSchema",
  "predicateText",
]);

export interface RejectedCandidate {
  index: number;
  candidate: unknown;
  errors: string[];
}

export interface MappedCandidates {
  accepted: StatementWrite[];
  /** The source candidates that produced `accepted`, index-aligned with it. */
  acceptedCandidates: CandidateStatement[];
  rejected: RejectedCandidate[];
  /** Exact duplicate candidates collapsed within one model result. */
  duplicateCandidates: number;
}

const normalizeSpace = (s: string): string => s.replace(/\s+/g, " ").trim().toLocaleLowerCase();
const contains = (haystack: string, needle: string): boolean =>
  normalizeSpace(haystack).includes(normalizeSpace(needle));

const NEGATION = /\b(?:not|no|never|none|without|avoid|reject(?:ed|s)?|don't|doesn't|didn't|shouldn't|cannot|can't|mustn't|won't|wouldn't)\b/i;
const HYPOTHETICAL = /\b(?:if|would|could|might|maybe|perhaps|suppose|supposing|imagine|hypothetical(?:ly)?)\b/i;
const TENTATIVE = /\b(?:think|should|maybe|perhaps|might|could|consider(?:ing)?|suggest(?:ed|ion)?|propose(?:d|s)?|undecided|haven't decided|hasn't decided|not decided)\b/i;

function sentenceAround(text: string, start: number, end: number): string {
  const boundary = /[.!?\n]/;
  let from = start;
  while (from > 0 && !boundary.test(text[from - 1]!)) from--;
  let to = end;
  while (to < text.length && !boundary.test(text[to]!)) to++;
  if (to < text.length) to++;
  return text.slice(from, to);
}

export function normalizePredicate(raw: string): string {
  return raw
    .trim()
    .toLocaleLowerCase()
    .replace(/[-\s]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

export function normalizeMention(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * Deterministic key order. A model that reorders `scope` keys between retries must
 * not mint a different statement id for the same content — that would silently turn
 * an idempotent re-run into duplicate statements.
 */
function sortedRecord(record: Record<string, string> | undefined): Record<string, string> | null {
  if (!record) return null;
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

/** Calendar date (YYYY-MM-DD) of `instant` as observed in `timeZone`. */
function localDateStr(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(instant);
}

function addLocalDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function weekdayIndex(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Resolve a relative temporal expression to a local calendar date using ONLY the
 * episode's own timestamp and timezone — never world knowledge. Returns null when
 * the expression carries no anchor we resolve here (absolute dates are not parsed
 * by Slice 3; they are accepted only as an unresolved `expression`).
 *
 * Rules, all evaluated against the episode's LOCAL date:
 *   yesterday/today/tomorrow  -> shifted local date
 *   "last <weekday>"          -> nearest occurrence strictly in the past
 *   "next <weekday>"          -> nearest occurrence strictly in the future
 *   bare "<weekday>"          -> most recent occurrence on or before that date
 */
function expectedRelativeDate(expression: string, episode: Episode): string | null {
  const expr = normalizeSpace(expression);
  const local = localDateStr(new Date(episode.occurredAt), episode.tz);
  if (/\byesterday\b/.test(expr)) return addLocalDays(local, -1);
  if (/\btomorrow\b/.test(expr)) return addLocalDays(local, 1);
  if (/\btoday\b/.test(expr)) return local;

  const match = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(expr);
  if (!match) return null;
  const target = WEEKDAYS.indexOf(match[1] as (typeof WEEKDAYS)[number]);
  const delta = (target - weekdayIndex(local) + 7) % 7;
  if (/\blast\b/.test(expr)) return addLocalDays(local, delta === 0 ? -7 : delta - 7);
  if (/\bnext\b/.test(expr)) return addLocalDays(local, delta === 0 ? 7 : delta + 7);
  return addLocalDays(local, delta === 0 ? 0 : delta - 7);
}

function entityFor(episode: Episode, name: string, type: Entity["type"], recordedAt: string): Entity {
  const canonicalName = normalizeMention(name);
  const id = "ent:" + ids.sha256(["mention", episode.id, canonicalName.toLocaleLowerCase(), type].join("|"));
  return {
    id,
    type,
    canonicalName,
    aliases: [],
    status: "active",
    createdAt: recordedAt,
    updatedAt: recordedAt,
  };
}

function decisionModalityError(decisionStatus: NonNullable<CandidateStatement["decisionStatus"]>, modality: CandidateStatement["modality"]): string | null {
  const allowed: Record<NonNullable<CandidateStatement["decisionStatus"]>, CandidateStatement["modality"][]> = {
    proposed: ["proposed", "considered", "uncertain"],
    accepted: ["decided"],
    rejected: ["rejected"],
    undecided: ["uncertain", "considered"],
  };
  return allowed[decisionStatus].includes(modality)
    ? null
    : `decisionStatus '${decisionStatus}' is incoherent with modality '${modality}'`;
}

function validateTemporal(candidate: CandidateStatement, episode: Episode): string[] {
  const errors: string[] = [];
  const t = candidate.temporal;
  if (!t) return errors;

  const hasFrom = t.validFrom !== undefined && t.validFrom !== null;
  const hasTo = t.validTo !== undefined && t.validTo !== null;

  if (t.expression && !contains(episode.text, t.expression)) {
    errors.push(`temporal expression '${t.expression}' does not appear in the source episode`);
  }
  if ((hasFrom || hasTo) && !t.expression) {
    errors.push("resolved temporal bounds require the original temporal expression");
  }
  // A resolved instant with `unknown` precision is incoherent: either the date is
  // known well enough to store, or it must stay null.
  if ((hasFrom || hasTo) && (!t.timePrecision || t.timePrecision === "unknown")) {
    errors.push("resolved temporal bounds require a declared time precision");
  }
  if (!hasFrom && hasTo) {
    errors.push("validTo cannot be resolved without validFrom");
  }
  if (hasFrom && hasTo && t.validTo! < t.validFrom!) {
    errors.push("validTo precedes validFrom");
  }
  if (t.validity === "bounded" && (!hasFrom || !hasTo)) {
    errors.push("validity 'bounded' requires both validFrom and validTo");
  }
  if (t.validity === "ongoing" && !hasFrom) {
    errors.push("validity 'ongoing' requires validFrom");
  }
  if (t.validity === "open_ended" && hasTo) {
    errors.push("validity 'open_ended' cannot have validTo");
  }

  if (t.expression && hasFrom) {
    const expected = expectedRelativeDate(t.expression, episode);
    if (expected) {
      const actual = localDateStr(new Date(t.validFrom!), episode.tz);
      if (actual !== expected) {
        errors.push(
          `temporal expression '${t.expression}' resolves to ${expected} in ${episode.tz} for this episode, not ${actual}`,
        );
      }
    }
  }
  return errors;
}

function identityTuple(
  candidate: CandidateStatement,
  predicate: string,
  predicateText: string | null,
  objectType: Entity["type"] | null,
  scope: Record<string, string> | null,
  qualifications: readonly string[] | undefined,
): unknown[] {
  return [
    normalizeMention(candidate.subject.name).toLocaleLowerCase(),
    candidate.subject.type ?? "concept",
    predicate,
    // The exact original predicate casing stored in `predicateQualifier` is part
    // of immutable content, so it must be part of identity too. Otherwise two
    // casings share an id but conflict on the store's contentHash (ADR-003).
    predicateText,
    candidate.object.kind,
    candidate.object.kind === "entity"
      ? normalizeMention(candidate.object.name).toLocaleLowerCase()
      : candidate.object.value,
    // The object entity id is derived from its type as well as its name, so a
    // different type changes the persisted objectId and must change the id.
    objectType,
    // Confidence is persisted and hashed in contentHash; include it so a retry
    // with a different confidence cannot reuse an id with different content.
    candidate.confidence,
    candidate.polarity,
    candidate.modality,
    candidate.decisionStatus ?? null,
    candidate.category ?? null,
    candidate.temporal?.expression ?? null,
    candidate.temporal?.validFrom ?? null,
    candidate.temporal?.validTo ?? null,
    candidate.temporal?.timePrecision ?? null,
    candidate.temporal?.validity ?? null,
    scope,
    qualifications ?? null,
    candidate.evidence.spanStart,
    candidate.evidence.spanEnd,
  ];
}

/**
 * Turn untrusted model candidates into persistence-ready writes. Every accepted
 * candidate has an exact source span and at least one Evidence entry; rejected
 * candidates are returned with reasons and are never written.
 */
export function validateCandidates(args: {
  episode: Episode;
  candidates: readonly CandidateStatement[];
  extractionModel: string;
  extractionPromptHash: string;
  extractionVersion: string;
  recordedAt: string;
}): MappedCandidates {
  const { episode, candidates, extractionModel, extractionPromptHash, extractionVersion, recordedAt } = args;
  const accepted: StatementWrite[] = [];
  const acceptedCandidates: CandidateStatement[] = [];
  const rejected: RejectedCandidate[] = [];
  const seen = new Set<string>();
  let duplicateCandidates = 0;

  candidates.forEach((candidate, index) => {
    const errors: string[] = [];
    const text = episode.text;
    const { spanStart, spanEnd, quote } = candidate.evidence;
    // Normalized once so the identity hash and the stored qualifier agree.
    const scope = sortedRecord(candidate.scope);
    const qualifications = candidate.qualifications ? [...candidate.qualifications].sort() : undefined;

    if (!Number.isInteger(spanStart) || !Number.isInteger(spanEnd) || spanStart < 0 || spanEnd <= spanStart) {
      errors.push("invalid source span bounds");
    } else if (spanEnd > text.length) {
      errors.push(`source span end ${spanEnd} exceeds episode length ${text.length}`);
    } else {
      const actual = text.slice(spanStart, spanEnd);
      if (actual !== quote) {
        errors.push("evidence quote does not exactly match the source span");
      }
    }

    if (!quote.trim()) errors.push("evidence quote is empty");
    const subjectName = normalizeMention(candidate.subject.name);
    if (!contains(text, subjectName)) {
      errors.push(`subject '${candidate.subject.name}' does not appear in the source episode`);
    }
    // The cited span itself must establish the subject. A subject that merely
    // occurs elsewhere in the episode cannot support a relationship attached
    // to an unrelated quote.
    if (!contains(quote, subjectName)) {
      errors.push(`subject '${candidate.subject.name}' does not appear in the cited source span`);
    }

    const objectName = candidate.object.kind === "entity"
      ? normalizeMention(candidate.object.name)
      : String(candidate.object.value);
    const objectMention = candidate.object.kind === "entity" || typeof candidate.object.value !== "boolean";
    if (objectMention && !contains(quote, objectName)) {
      errors.push(`object '${objectName}' does not appear in the cited source span`);
    }

    const sentence = spanStart >= 0 && spanEnd <= text.length
      ? sentenceAround(text, spanStart, spanEnd)
      : text;

    if (candidate.polarity === "negative" && !NEGATION.test(sentence)) {
      errors.push("negative polarity is not supported by a negation cue in the cited sentence");
    }

    const trimmed = sentence.trim();
    // A leading auxiliary only signals a question when the sentence really is
    // interrogative: "Do use MongoDB" is an imperative, not a question.
    const isQuestion = /\?\s*$/.test(trimmed)
      || /^\s*(?:who|what|when|where|why|how|should|can|could|would|is|are|was|were)\b/i.test(trimmed);
    const isQuestionMeta = candidate.predicate.toLocaleLowerCase().trim() === "asked_about";
    if (isQuestion && !isQuestionMeta && ["asserted", "decided", "proposed", "preferred"].includes(candidate.modality)) {
      errors.push(`question text cannot be extracted as modality '${candidate.modality}'`);
    }

    // A hypothetical is never a commitment. Non-committal modalities
    // (proposed/preferred/uncertain/hypothetical/questioned/…) may survive it.
    if (HYPOTHETICAL.test(sentence) && ["asserted", "decided"].includes(candidate.modality)) {
      errors.push(`hypothetical text cannot be extracted as modality '${candidate.modality}'`);
    }

    // Hedged wording ("think", "should", "maybe", "suggest", "undecided") is never
    // a plain fact and never an accepted decision.
    if (["asserted", "decided", "accepted"].includes(candidate.modality) && TENTATIVE.test(sentence)) {
      errors.push(`tentative text cannot be extracted as modality '${candidate.modality}'`);
    }

    if (candidate.decisionStatus) {
      const err = decisionModalityError(candidate.decisionStatus, candidate.modality);
      if (err) errors.push(err);
    }

    errors.push(...validateTemporal(candidate, episode));

    for (const q of qualifications ?? []) {
      if (!contains(text, q)) errors.push(`qualification '${q}' does not appear in the source episode`);
    }

    for (const key of Object.keys(scope ?? {})) {
      if (RESERVED_QUALIFIER_KEYS.has(key)) errors.push(`scope key '${key}' is reserved`);
    }

    const predicate = normalizePredicate(candidate.predicate);
    if (!predicate) {
      errors.push("predicate is empty after normalization");
    } else if (!EXTRACTION_PREDICATES.has(predicate)) {
      errors.push(`predicate '${candidate.predicate}' is not in the extraction predicate vocabulary`);
    }

    if (errors.length > 0) {
      rejected.push({ index, candidate, errors });
      return;
    }

    // Compute the exact predicateText and object entity type once, so the values
    // hashed into identity are the same ones written to persisted content.
    const predicateText = normalizePredicate(candidate.predicate) !== candidate.predicate.trim().toLocaleLowerCase()
      ? candidate.predicate.trim()
      : null;
    const objectType = candidate.object.kind === "entity" ? (candidate.object.type ?? "concept") : null;
    const identity = JSON.stringify(identityTuple(candidate, predicate, predicateText, objectType, scope, qualifications));
    const statementId = "stmt:" + ids.sha256([extractionVersion, episode.id, identity].join("|"));
    if (seen.has(statementId)) {
      duplicateCandidates += 1;
      return;
    }
    seen.add(statementId);

    const subject = entityFor(episode, candidate.subject.name, candidate.subject.type ?? "concept", recordedAt);
    const objectEntity = candidate.object.kind === "entity"
      ? entityFor(episode, candidate.object.name, candidate.object.type ?? "concept", recordedAt)
      : null;

    const evidence: Evidence = {
      id: "ev:" + ids.sha256(["evidence", episode.id, spanStart, spanEnd, quote].join("|")),
      kind: "episode_span",
      episodeId: episode.id,
      messageExternalId: episode.externalId,
      spanStart,
      spanEnd,
      quote,
    };

    const validity = candidate.temporal?.validity
      ?? (candidate.temporal?.validFrom && candidate.temporal?.validTo ? "bounded" : "open_ended");

    const qualifier: Record<string, string> = {};
    if (candidate.category) qualifier.statementType = candidate.category;
    if (candidate.decisionStatus) qualifier.decisionStatus = candidate.decisionStatus;
    if (candidate.temporal?.expression) qualifier.temporalExpression = candidate.temporal.expression;
    if (qualifications?.length) qualifier.qualifications = JSON.stringify(qualifications);
    if (predicateText !== null) qualifier.predicateText = predicateText;
    for (const [key, value] of Object.entries(scope ?? {})) qualifier[key] = value;
    qualifier.extractionStatus = "accepted";
    qualifier.extractionSchema = EXTRACTION_SCHEMA_VERSION;

    const authority = episode.role === "user"
      ? { assertedBy: "user" as const, epistemicStatus: "user_asserted" as const }
      : episode.role === "assistant"
        ? { assertedBy: "assistant" as const, epistemicStatus: "model_inferred" as const }
        : { assertedBy: "extraction" as const, epistemicStatus: "model_inferred" as const };

    const statement: Omit<Statement, "status"> = {
      id: statementId,
      subjectId: subject.id,
      predicate,
      predicateQualifier: qualifier,
      objectKind: candidate.object.kind,
      ...(objectEntity ? { objectId: objectEntity.id } : { objectValue: candidate.object.kind === "literal" ? candidate.object.value : undefined }),
      polarity: candidate.polarity,
      modality: candidate.modality,
      ...authority,
      confidence: candidate.confidence,
      extractionModel,
      extractionPromptHash,
      validFrom: candidate.temporal?.validFrom ?? null,
      validTo: candidate.temporal?.validTo ?? null,
      timePrecision: candidate.temporal?.timePrecision ?? "unknown",
      validity,
      recordedAt,
    };

    if (statement.objectKind === "literal" && statement.objectValue === undefined) {
      rejected.push({ index, candidate, errors: ["literal object has no value"] });
      return;
    }

    const entities = objectEntity && objectEntity.id !== subject.id ? [subject, objectEntity] : [subject];
    accepted.push({ statement, evidence: [evidence], entities });
    acceptedCandidates.push(candidate);
  });

  return { accepted, acceptedCandidates, rejected, duplicateCandidates };
}

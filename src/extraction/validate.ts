import { ids } from "../core/ids.js";
import type {
  CandidateStatement, Entity, Episode, Evidence, Statement,
} from "../contracts/schemas.js";
import type { StatementWrite } from "../contracts/ports.js";

/** Bump when the candidate contract or validation semantics change. */
export const EXTRACTION_SCHEMA_VERSION = "candidate/1";

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

function normalizePredicate(raw: string): string {
  return raw
    .trim()
    .toLocaleLowerCase()
    .replace(/[-\s]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

function normalizeMention(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
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

function validateTemporal(candidate: CandidateStatement, episodeText: string): string[] {
  const errors: string[] = [];
  const t = candidate.temporal;
  if (!t) return errors;

  if (t.expression && !contains(episodeText, t.expression)) {
    errors.push(`temporal expression '${t.expression}' does not appear in the source episode`);
  }
  if ((t.validFrom !== undefined && t.validFrom !== null) || (t.validTo !== undefined && t.validTo !== null)) {
    if (!t.expression) {
      errors.push("resolved temporal bounds require the original temporal expression");
    }
  }
  if ((t.validFrom === undefined || t.validFrom === null) && t.validTo !== undefined && t.validTo !== null) {
    errors.push("validTo cannot be resolved without validFrom");
  }
  if (t.validFrom && t.validTo && t.validTo < t.validFrom) {
    errors.push("validTo precedes validFrom");
  }
  if (t.validity === "bounded" && (!t.validFrom || !t.validTo)) {
    errors.push("validity 'bounded' requires both validFrom and validTo");
  }
  if (t.validity === "ongoing" && !t.validFrom) {
    errors.push("validity 'ongoing' requires validFrom");
  }
  if (t.validity === "open_ended" && t.validTo) {
    errors.push("validity 'open_ended' cannot have validTo");
  }
  return errors;
}

function identityTuple(candidate: CandidateStatement, predicate: string): unknown[] {
  return [
    normalizeMention(candidate.subject.name).toLocaleLowerCase(),
    candidate.subject.type ?? "concept",
    predicate,
    candidate.object.kind,
    candidate.object.kind === "entity"
      ? normalizeMention(candidate.object.name).toLocaleLowerCase()
      : candidate.object.value,
    candidate.polarity,
    candidate.modality,
    candidate.decisionStatus ?? null,
    candidate.category ?? null,
    candidate.temporal?.expression ?? null,
    candidate.temporal?.validFrom ?? null,
    candidate.temporal?.validTo ?? null,
    candidate.temporal?.timePrecision ?? null,
    candidate.temporal?.validity ?? null,
    candidate.scope ?? null,
    candidate.qualifications ?? null,
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
  const rejected: RejectedCandidate[] = [];
  const seen = new Set<string>();
  let duplicateCandidates = 0;

  candidates.forEach((candidate, index) => {
    const errors: string[] = [];
    const text = episode.text;
    const { spanStart, spanEnd, quote } = candidate.evidence;

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

    const isQuestion = /[?]\s*$/.test(sentence.trim()) || /^\s*(?:who|what|when|where|why|how|should|can|could|would|do|does|did|is|are|was|were)\b/i.test(sentence.trim());
    const isQuestionMeta = candidate.predicate.toLocaleLowerCase().trim() === "asked_about";
    if (isQuestion && !isQuestionMeta && ["asserted", "decided", "proposed", "preferred"].includes(candidate.modality)) {
      errors.push(`question text cannot be extracted as modality '${candidate.modality}'`);
    }

    if (HYPOTHETICAL.test(sentence) && ["asserted", "decided", "proposed", "preferred"].includes(candidate.modality)) {
      errors.push(`hypothetical text cannot be extracted as modality '${candidate.modality}'`);
    }

    if (["decided", "accepted"].includes(candidate.modality) && TENTATIVE.test(sentence)) {
      errors.push(`tentative text cannot be extracted as modality '${candidate.modality}'`);
    }

    if (candidate.decisionStatus) {
      const err = decisionModalityError(candidate.decisionStatus, candidate.modality);
      if (err) errors.push(err);
    }

    errors.push(...validateTemporal(candidate, text));

    for (const q of candidate.qualifications ?? []) {
      if (!contains(text, q)) errors.push(`qualification '${q}' does not appear in the source episode`);
    }

    for (const key of Object.keys(candidate.scope ?? {})) {
      if (RESERVED_QUALIFIER_KEYS.has(key)) errors.push(`scope key '${key}' is reserved`);
    }

    const predicate = normalizePredicate(candidate.predicate);
    if (!predicate) errors.push("predicate is empty after normalization");

    if (errors.length > 0) {
      rejected.push({ index, candidate, errors });
      return;
    }

    const identity = JSON.stringify(identityTuple(candidate, predicate));
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
    if (candidate.qualifications?.length) qualifier.qualifications = JSON.stringify(candidate.qualifications);
    if (normalizePredicate(candidate.predicate) !== candidate.predicate.trim().toLocaleLowerCase()) {
      qualifier.predicateText = candidate.predicate.trim();
    }
    for (const [key, value] of Object.entries(candidate.scope ?? {})) qualifier[key] = value;
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
  });

  return { accepted, rejected, duplicateCandidates };
}

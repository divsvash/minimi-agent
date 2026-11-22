import type { CandidateSignal, Entity, ResolutionRequest, ScoredCandidate } from "../contracts/schemas.js";
import type { EmbeddingProvider } from "../contracts/ports.js";

/**
 * Candidate GENERATION only (ADR-006). Similarity produces ranked candidates
 * with recorded signals; it never authorizes identity, linking or merging.
 */

export function normalizeName(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trigramSet(value: string): Set<string> {
  const padded = `  ${normalizeName(value)} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** Overlap coefficient on padded trigrams — recall-oriented, never an identity gate. */
export function trigramSimilarity(a: string, b: string): number {
  const x = trigramSet(a);
  const y = trigramSet(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const gram of x) if (y.has(gram)) shared++;
  return shared / Math.max(x.size, y.size);
}

function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const AUTHORITATIVE = new Set(["external_id", "confirmed_entity", "exact_alias"]);

export async function generateCandidates(args: {
  request: ResolutionRequest;
  entities: readonly Entity[];
  embeddings?: EmbeddingProvider;
}): Promise<ScoredCandidate[]> {
  const { request, entities, embeddings } = args;
  const mentionName = request.mention.name;
  const mentionNorm = normalizeName(mentionName);
  const evidence = request.evidence;

  // Optional extension point: an existing EmbeddingProvider contract is used if
  // injected. No vector store, no new provider stack, no implicit network call.
  const mentionVector = embeddings ? (await embeddings.embed([mentionName]))[0] : undefined;
  const entityVectors = embeddings && entities.length > 0
    ? await embeddings.embed(entities.map((e) => e.canonicalName))
    : undefined;

  const candidates: ScoredCandidate[] = [];
  for (const [index, entity] of entities.entries()) {
    const signals: CandidateSignal[] = [];

    if (request.mention.type && request.mention.type !== entity.type) {
      // Type incompatibility is a hard identity barrier; keep it visible but not plausible.
      signals.push({
        kind: "type_mismatch",
        detail: `mention type '${request.mention.type}' vs entity type '${entity.type}'`,
        score: 0,
      });
      candidates.push({
        entityId: entity.id,
        canonicalName: entity.canonicalName,
        type: entity.type,
        score: 0,
        signals,
        authoritative: false,
      });
      continue;
    }

    signals.push({ kind: "same_type", detail: `type '${entity.type}'`, score: 0.25 });

    for (const [key, value] of Object.entries(evidence?.externalIds ?? {})) {
      if (entity.externalIds?.[key] === value) {
        signals.push({ kind: "external_id", detail: `${key}=${value}`, score: 10 });
      }
    }
    if (evidence?.confirmedEntityId === entity.id) {
      signals.push({ kind: "confirmed_entity", detail: "prior explicit user confirmation", score: 10 });
    }

    if (entity.canonicalName === mentionName) {
      signals.push({ kind: "exact_canonical_name", detail: "canonical name equals the mention", score: 3 });
    } else if (normalizeName(entity.canonicalName) === mentionNorm) {
      signals.push({ kind: "normalized_name", detail: "normalized canonical name equals the mention", score: 2 });
    }

    if (entity.aliases.includes(mentionName)) {
      signals.push({ kind: "exact_alias", detail: "mention is an existing alias", score: 4 });
    } else if (entity.aliases.some((alias) => normalizeName(alias) === mentionNorm)) {
      signals.push({ kind: "normalized_name", detail: "normalized alias equals the mention", score: 1.5 });
    }

    const trigram = trigramSimilarity(entity.canonicalName, mentionName);
    if (trigram >= 0.3) {
      signals.push({ kind: "trigram", detail: `overlap ${trigram.toFixed(3)}`, score: trigram });
    }

    const vector = entityVectors?.[index];
    if (mentionVector && vector) {
      const similarity = cosine(mentionVector, vector);
      if (similarity >= 0.85) {
        signals.push({ kind: "embedding", detail: `cosine ${similarity.toFixed(3)}`, score: similarity });
      }
    }

    // Type compatibility alone is never a reason to surface a candidate.
    if (!signals.some((signal) => signal.kind !== "same_type")) continue;

    const score = signals.reduce((sum, signal) => sum + signal.score, 0);
    candidates.push({
      entityId: entity.id,
      canonicalName: entity.canonicalName,
      type: entity.type,
      score,
      signals,
      authoritative: signals.some((signal) => AUTHORITATIVE.has(signal.kind)),
    });
  }

  return candidates
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.entityId.localeCompare(b.entityId));
}

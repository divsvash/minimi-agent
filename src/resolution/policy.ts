import { ids } from "../core/ids.js";
import { normalizeName } from "./candidates.js";
import type { ResolutionDecision, ResolutionRequest, ScoredCandidate } from "../contracts/schemas.js";

/**
 * Decision ladder (ADR-006). Ranking and identity are separate: a high score,
 * cosine similarity or model confidence can never by itself produce `matched`.
 * Only explicit identity evidence or an authoritative alias mapping can.
 */
export function decide(request: ResolutionRequest, candidates: readonly ScoredCandidate[]): ResolutionDecision {
  const resolutionId = "res:" + ids.sha256(JSON.stringify([
    normalizeName(request.mention.name),
    request.mention.type ?? null,
    request.episodeId ?? null,
    request.evidence ?? null,
  ]));
  const describe = (c: ScoredCandidate) =>
    `${c.entityId}[${c.signals.map((s) => s.kind).join(",")}]`;

  // A canonical name is an entity's own authoritative alias; it authorizes only
  // when it designates exactly one entity. Two exact names ⇒ ambiguous identity.
  const authoritative = candidates.filter(
    (c) => c.authoritative || c.signals.some((s) => s.kind === "exact_canonical_name"),
  );
  if (authoritative.length === 1) {
    const only = authoritative[0]!;
    return {
      outcome: "matched",
      entityId: only.entityId,
      resolutionId,
      candidates: [...candidates],
      rationale: `Authoritative identity signal (${describe(only)}); no competing authoritative candidate. Similarity was not used to authorize.`,
    };
  }
  if (authoritative.length > 1) {
    return {
      outcome: "ambiguous",
      resolutionId,
      candidates: [...candidates],
      rationale: `${authoritative.length} authoritative candidates (${authoritative.map(describe).join(" ")}); no identity chosen.`,
    };
  }

  // Candidate generation already discards type-only noise; every remaining
  // candidate has a real name/alias/external-id/embedding signal and is plausible.
  const plausible = candidates;
  if (plausible.length === 0) {
    return {
      outcome: "new_entity",
      entityId: "ent:" + ids.sha256(`resolution|new|${resolutionId}`),
      resolutionId,
      candidates: [...candidates],
      rationale: "No credible existing candidate; create an unresolved mention-scoped entity. No merge performed.",
    };
  }
  if (plausible.length === 1) {
    return {
      outcome: "review_required",
      resolutionId,
      candidates: [...candidates],
      rationale: `Only similarity/weak signals support ${describe(plausible[0]!)}; identity evidence is insufficient, so no link or merge is authorized.`,
    };
  }
  return {
    outcome: "ambiguous",
    resolutionId,
    candidates: [...candidates],
    rationale: `${plausible.length} plausible candidates (${plausible.map(describe).join(" ")}); do not pick a winner.`,
  };
}

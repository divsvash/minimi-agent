# ADR-006: Similarity never authorizes merges; explicit, remembered authorization only

**Status:** Accepted

## Context
Entity resolution is the highest-blast-radius subsystem: a false merge poisons every downstream fact, evidence chain, and answer attached to the merged entity, and the damage is silent (queries return confidently wrong attribution). Embedding cosine similarity is an excellent *candidate generator* and a terrible *judge* — it cannot distinguish "HubSpot" from "HubSpot CRM" (same) from "HubSpot" from "HubSpot.com login page subject" (different contexts), and it cannot see type constraints or user intent.

## Decision
**No merge may be authorized by embedding similarity, alone or combined with name heuristics.** Authorization requires one of:

1. **Alias-exact link** under a shared type — direct attachment (indexing, not merging; reversible by alias edit, never destructive).
2. **Strong identity evidence + prior explicit user confirmation** (a stored `MergePolicy` from a past `same entity` action, or identical external id e.g. Wikidata Q-id) — auto-link permitted and audited.
3. **Explicit user/admin merge action** (`POST /entities/merge`, UI "same entity") → creates `MERGED_INTO` + `:MergeEvent` (+ optional `MergePolicy` recording the authorization for future auto-links).

Everything else lands in a **review queue**; the statement persists against its best candidate with `resolutionStatus: contested` or attaches to `:UnresolvedEntity` (flagged, excluded, never dropped).

Splits are equally explicit: `POST /entities/split` requires a **reassignment plan** (statementIds, evidenceIds, aliases per target). Items not in the plan remain flagged for review — the system never infers correct placement from "the merge was wrong". Merge/split audit events are immutable and replayable.

Prior contradictory design (cos ≥ 0.92 auto-merge) was rejected for exactly the failure above: silent, unreviewable, evidence-corrupting.

## Rejected alternatives
- **Similarity threshold auto-merge (0.85/0.92/0.95…):** any threshold has false positives at personal-memory scale (short strings, shared product words like "Force"); error is silent and compounding. Threshold tuning is numerology, not engineering. Rejected.
- **LLM-as-judge merge authorization:** nondeterministic, unauditable across reruns, expensive; violates eval reproducibility (ADR-012). Permitted only as a *ranking hint* inside the review queue UI, never as an actor.
- **Destructive merge with re-link rewrite:** loses original attribution; reversal impossible without full replay; rejected per ADR-004 spirit.
- **Split by heuristic re-resolution:** unverifiable correctness; replaced by explicit-plan split (acceptance test asserts exact mapping reassignment).
- **Two-phase commit with user confirmation on every merge (chat-time prompting):** correct but UX-hostile; the review queue + contested flag gives the same correctness asynchronously.

## Consequences
- More review-queue load than an auto-merging system; treated as a feature (human-in-the-loop for identity is the correct default for personal memory).
- Duplicate entities persist longer; they are visible, countable, and low-harm (unlike merges), and the review queue resolves them.
- Eval Slice 4 asserts: five CRM products stay distinct with no human input; cos-0.97-no-evidence ⇒ review queue; user-confirmed pair ⇒ auto-link; split reassigns exactly the planned mapping with audit intact.

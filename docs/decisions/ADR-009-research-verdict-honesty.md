# ADR-009: Research verdicts and explicit research coverage — no change is never assumed

**Status:** Accepted (refined — verdicts now gated on a structured coverage record)

## Context
The prior draft's `no_change_found` lumped together page redesigns, login walls, extraction failures, and dimension mismatches. These are not equivalent outcomes and must not share a label. Additionally, `verified_unchanged` must not be reachable from stale or weak sources.

## Decision

### ResearchRun coverage record (mandatory, stored, attached to every verdict)
Every research run writes a `:ResearchRun { id, entity, attribute, dims, queries[], startedAt, completedAt,
  relevantSourceFound: bool,      // ≥1 candidate judged relevant to the attribute+dimensions
  sourceAccessible: bool,         // fetched with a usable response (not 4xx/login-wall/timeout)
  attributeExtracted: bool,       // schema-valid extraction of the attribute succeeded
  dimensionsMatchedBaseline: bool,// extracted dims comparable to historical baseline (else mismatch reported separately)
  sourceAuthoritative: bool,      // domain/publisher allowlist or explicit verification flag
  sourceFreshEnough: bool,        // attribute-specific freshness policy (pricing ≤ N days; release notes ≤ M days)
  conflictingSourcesFound: bool,  // same dims, different values across independent sources
  coverageNotes: string }`.
Missing flags are recorded as reasons; the record is part of the answer's evidence.

### ComparisonOutcome (still separate — never a verdict)
`comparable | dimension_mismatch{mismatchedKeys[]} | normalization_mismatch{versions}` — computed before verdicts; mismatches never become "nothing changed".

### The four verdicts — now precisely gated
- `changed`: `relevantSourceFound ∧ sourceAccessible ∧ attributeExtracted ∧ sourceAuthoritative ∧ sourceFreshEnough`, `comparable`, normalized values differ. (Conflicts → both observations kept, verdict still `changed` but rendered with both sides; never averaged.)
- `verified_unchanged`: same gates **all true**, `comparable`, values equal, `sourceFreshEnough`, and **no unresolved conflict**. A stale page (fetch succeeded but publication/effective date older than policy) can never produce this verdict.
- `no_change_found`: research executed; **at least one of** `relevantSourceFound=false` (searched, nothing relevant), `sourceAccessible=false` (all relevant sources blocked), `attributeExtracted=false`, or `dimensionsMatchedBaseline=false` (mismatch reported as `ComparisonOutcome`, values shown side-by-side, not differenced) — with the failing flags listed in the answer.
- `insufficient_evidence`: nothing usable at all — all candidate sources inaccessible **or** extraction impossible **or** entity unresolvable; `coverageStatus=failed`; queries listed verbatim.

### Honesty rules (unchanged, now enforced via the coverage record)
Absence of search results ⇒ `insufficient_evidence`. Unusable source ⇒ `no_change_found` with reason. Stale source ⇒ never `verified_unchanged`. Dimension mismatch ⇒ `ComparisonOutcome`, reported, never a change or no-change verdict. Every verdict renders its ResearchRun; synthesis must name the failing coverage flags, not paraphrase them away.

Identical gating for pricing and product releases (freshness windows differ per attribute; policy table in config, versioned).

## Rejected alternatives
- **Single `no_change_found` bucket (prior draft):** erases the difference between "we looked and found nothing relevant" and "the vendor hid the page" and "it's a different plan's price"; destroys auditability; rejected — coverage record replaces it.
- **Verdict from stale page via recency-of-fetch:** conflates "we read it" with "it's current"; rejected — `sourceFreshEnough` is computed from source-declared dates, not fetch time.
- **Conflict resolution by source rank to force `verified_unchanged`:** manufactures consensus; conflicts are surfaced with publishers and dates; rejected.
- **ComparisonOutcome folded into the verdict enum:** mismatch is about comparability, not research outcome — kept separate (unchanged from prior decision).

## Consequences
- Verdicts are now mechanically checkable against the coverage record — eval asserts the gating function directly (unit) in addition to end-to-end fixture verdicts.
- More answers terminate at `no_change_found`/`insufficient_evidence` — intended; the UI shows exactly what failed and what would resolve it.
- Freshness policy is per-attribute configuration with a versioned table; policy changes bump the record schema version and are logged.

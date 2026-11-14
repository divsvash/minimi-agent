# ADR-009: Research verdicts — a disjoint ladder with per-attempt coverage

**Status:** Accepted (supersedes the overlapping four-verdict definitions)

## Context
The prior definitions overlapped: `no_change_found` absorbed inaccessible sources, failed extraction, and absent results — the same failure modes as `insufficient_evidence`. Absence of search results was simultaneously declared `insufficient_evidence` and included in `no_change_found`. Two verdicts could describe the same run, which destroys auditability and makes synthesis wording arbitrary. This ADR defines a **precedence ladder**: exactly one verdict per ResearchRun, chosen by first match, plus **per-source-attempt coverage records** so one successful source cannot conceal several failed ones.

## Decision

### ResearchRun coverage — per attempt, not aggregate
Every search query and every fetch attempt is recorded individually:
`attempts[]: { query?, url?, sourceId, outcome: 'ok'|'http_error'|'timeout'|'blocked'|'parse_error',
  relevant: bool, accessible: bool, attrExtracted: bool, dimsComparable: bool?, value?, sourceEffectiveAt?,
  sourcePublishedAt?, authoritative: bool, fresh: bool, conflictWith?: string (obsId) }`.
Aggregate flags (`relevantSourceFound`, `sourceAccessible`, …) are **derived** from `attempts[]` for query convenience only; the attempts are authoritative. A run with one successful source and five failures knows about all six.

### ComparisonOutcome (unchanged — still not a verdict)
`comparable | dimension_mismatch{mismatchedKeys[]} | normalization_mismatch{versions}`.

### The four verdicts — non-overlapping, precedence-ordered (first match wins)
Given a ResearchRun and its baseline, evaluate in order:

1. **`insufficient_evidence`** — the evidence base could not be established at all:
   - `entity_resolution_failed` (subject entity unresolvable), or
   - **every** recorded attempt failed (zero `outcome='ok'` attempts — including "search returned zero candidates and fetched nothing").
   The failing attempts are listed verbatim.
2. **`changed`** — at least one accessible, relevant, extractable source exists; at least one current observation was extracted; it is `comparable` to the baseline; normalized values differ. Requires `authoritative ∧ fresh` (per-attribute freshness policy). Conflicting independent sources are kept and rendered (both publishers, both captures) — the verdict stands, never averaged.
3. **`verified_unchanged`** — same preconditions as (2) with values equal, `authoritative ∧ fresh`, and **no unresolved conflict**. A stale page yields no verdict from this rung — fall through.
4. **`no_change_found`** — the run completed with a partial evidence base (at least one `outcome='ok'` attempt) but could not establish a current, comparable value. `reason` is **mandatory and specific**:
   - `stale_source` — observation extracted, but `sourceFreshEnough=false` (source-declared date older than policy; fetch time is never freshness);
   - `source_not_authoritative` — usable page, authority gate failed;
   - `dimension_mismatch` — extracted dims don't match baseline; values shown side-by-side, never differenced (ComparisonOutcome carried separately);
   - `attribute_not_extracted` — accessible, relevant source; schema extraction failed;
   - `no_relevant_source` — pages fetched successfully, none relevant to the attribute/dimensions;
   - `conflicting_unresolved` — comparable claims from independent sources disagree and none can be preferred; both shown.

Each verdict carries its ResearchRun id; synthesis must name the exact rung and reason (e.g., "could not confirm: stale page (published 2025-08-01, policy ≤ 30 days)").

### Rules
Absence of results never proves absence of change. `dimension_mismatch` is never evidence of "no change." Freshness is computed from source-declared dates, never from fetch time. `sourceFreshEnough` and `sourceAuthoritative` gate rungs 2–3 only. One ResearchRun ⇒ exactly one verdict (first matching rung).

Applies identically to pricing and releases/versions (freshness windows differ per attribute; policy table versioned in config).

## Rejected alternatives
- **Overlapping definitions (prior draft):** same run satisfiable by two verdicts; rejected — precedence ladder resolves.
- **Aggregate-only coverage booleans:** one green source launders five failures; rejected — per-attempt records are authoritative.
- **`stale_source` as `insufficient_evidence`:** conflates "nothing usable" with "something usable but not current" — different epistemic status, different remediation; rejected.
- **Dimension mismatch counted toward "no change" evidence-wise:** repeating ADR-009's core rule — mismatch says "not comparable," never "unchanged," and is excluded from no_change_found's *evidence* claim (it is one of its enumerated *reasons*, presented as such).

## Consequences
- Verdict gating is now a pure function of `attempts[]` — unit-testable in isolation; golden cases assert the ladder directly.
- ResearchRun storage grows with attempt records; acceptable, hashes and small flags only.
- UI/synthesis gains a reason taxonomy to render (`reason` enum) — small cost, large trust payoff.

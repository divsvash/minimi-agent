# ADR-005: Immutable Observations; Capture-backed dedup; cross-source disagreement is first-class

**Status:** Accepted (refined — adds cross-source semantics and failed-fetch Captures)

## Context
Observations are immutable measurements from external sources; Captures record each fetch. Two gaps were unspecified: (1) two independent sources reporting **different values for identical dimensions, currency, billing period, and effective period** — earlier text didn't say who supersedes whom; (2) what a **failed fetch** records.

## Decision

### Cross-source disagreement (no cross-source supersession)
- Observations dedup **within a source lineage**, never across sources. Source lineage key: `sourceKey = f(canonical_host, publisher)` recorded on the observation.
- `SUPERSEDED_BY` may connect observations **from the same lineage only** (same vendor/page family, e.g., `stripe.com` pricing page re-fetched). A later-captured disagreeing observation from another lineage (`blog.example.com` vs `vendor.com`, or two mirror sites) **never supersedes** — both stand, linked by `CONFLICTS_WITH`, with full capture provenance, and synthesis must present both (publisher, access date) without choosing.
- Extraction-source conflicts are a research outcome flag (`conflictingSourcesFound=true` on ResearchRun, ADR-009), not a resolution mechanism.
- "Latest wins" is never a rule. "Same source, newer observedAt" is the *only* supersession that exists.

### Failed fetches are evidence too
- Every fetch attempt — including failures — writes a `:Capture { id, fetchedAt, sourceUrl, httpStatus, errorKind?, bodyHash?, extractedFieldHashes?, jobId, outcome: 'ok'|'http_error'|'timeout'|'parse_error'|'blocked' }`.
- A failed Capture has **no `OBSERVED` relationship** (it observed nothing) but **does** exist and counts toward `ResearchRun.coverageStatus` (ADR-009). "No results" answers must be able to list tried-and-failed URLs.
- `bodyHash` is present only for `outcome:'ok'`. Distinguishing `blocked`/login-wall from `timeout` matters for coverage honesty.
- Captures are cheap and append-only; they are the replay input for eval fixtures and the audit trail for both successes and failures.

### Unchanged mechanics (restated)
- Immutable nodes; supersession only via `SUPERSEDED_BY` (relationship, never node mutation); two fetches of an identical page → two Captures, one Observation (obsKey dedup); changed values → new Observation + chain edge; cross-node mutation never occurs.
- `obs-norm/1` canonicalization and versioned identity (obsKey incl. `obsNormVersion`) unchanged. `COMPARABLE_TO` remains derived cache only.

## Rejected alternatives
- **Latest-capture-wins across sources:** silent source substitution; reviewer's exact failure case; rejected.
- **Lineage-blind supersession:** same bug, slower; rejected via `sourceKey` restriction.
- **Failed fetches unrecorded ("we just found nothing"):** destroys the coverage accounting that ADR-009 verdicts depend on; rejected — failed Captures are mandatory.
- **Source-quality scoring to auto-resolve conflicts:** manufactures certainty; surfaced conflicts are more honest and are the challenge's provenance requirement; rejected.
- **Capture without outcome enum (free-text errors):** breaks automated coverage accounting and eval assertions; rejected.

## Consequences
- Conflict-heavy domains (pricing via aggregators vs vendor pages) will regularly surface two observations; UI/synthesis must render disagreement — golden cases assert this.
- Storage grows with failed captures; retention policy documented (hashes only, no bodies).
- The dedup key loses meaning across sources by construction — intentional: duplicates across lineages are *disagreements or confirmations*, both valuable, never collapsed.

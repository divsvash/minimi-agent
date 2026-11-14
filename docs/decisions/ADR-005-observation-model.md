# ADR-005: Immutable Observations; Capture-backed dedup; cross-source disagreement is first-class

**Status:** Accepted (refined — adds cross-source semantics and failed-fetch Captures)

## Context
Observations are immutable measurements from external sources; Captures record each fetch. Two gaps were unspecified: (1) two independent sources reporting **different values for identical dimensions, currency, billing period, and effective period** — earlier text didn't say who supersedes whom; (2) what a **failed fetch** records.

## Decision

### Cross-source disagreement and supersession (source identity is explicit)
- **Source identity (`sourceId`)** is not inferred from the URL at fetch time. Resolution order: (1) **manually configured source identity** in config (e.g., `sourceId: "stripe-pricing-page"` pinned to the vendor pricing page) — wins when present; (2) **publisher identity** (the authoritative publisher/organization for the document, e.g., from schema.org/OG metadata or domain ownership); (3) **canonical host** (the canonicalized host, e.g., `stripe.com`) as the fallback lineage key; (4) **source family** (a configured family grouping, e.g., `pricing-aggregator`) only when the family is explicitly declared — never guessed.
- **URL movement is expected**: vendors move pages, restructure DOM, rename paths. Observations bind to `sourceId`, not to a canonical URL; a capture at a *new* URL for the same configured `sourceId` refines the same lineage. Canonical-URL is still recorded per capture (and used for dedup within a fetch), but it is not the identity of the observation.
- **Same-lineage supersession requires genuine replacement, not recency.** A newer Capture never by itself supersedes an Observation. Supersession `(:Observation)-[:SUPERSEDED_BY]->(:Observation)` within one `sourceId` lineage requires: the candidate successor's `sourceEffectiveAt` ≥ the superseded observation's `sourceEffectiveAt` (or the source explicitly declares supersession of the prior value), **and** the extracted value differs in the comparable dimension set (or the source explicitly states withdrawal/deprecation). Same value with newer effective date ⇒ no supersession; a new Capture attaches to the existing Observation. A restructured page yielding equal values is *confirmation*, not replacement.
- **Cross-lineage:** independent sources **never supersede each other**, regardless of recency — both stand, `CONFLICTS_WITH` links them, synthesis presents both. There is no "newer page forgives older page" rule across lineages either.
- A change in page structure with a *different* historical effective period (e.g., new page documents prices effective 2026-12 vs our stored 2026-07) produces a **new observation in the same lineage that is complementary, not superseding** — historical prices for non-overlapping effective periods are both retained; they are distinguished by `sourceEffectiveAt`, and comparison uses exact-period matching (§ ADR-009 ladder, dimension/effective-period gates), not "latest wins."
- Conflicts within a lineage (source contradicts its own earlier effective assertion without declaring supersession) are surfaced, never auto-resolved.

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
- **Lineage-blind supersession:** same bug, slower; rejected via explicit `sourceId` lineage resolution.
- **Failed fetches unrecorded ("we just found nothing"):** destroys the coverage accounting that ADR-009 verdicts depend on; rejected — failed Captures are mandatory.
- **Source-quality scoring to auto-resolve conflicts:** manufactures certainty; surfaced conflicts are more honest and are the challenge's provenance requirement; rejected.
- **Capture without outcome enum (free-text errors):** breaks automated coverage accounting and eval assertions; rejected.

## Consequences
- Conflict-heavy domains (pricing via aggregators vs vendor pages) will regularly surface two observations; UI/synthesis must render disagreement — golden cases assert this.
- Storage grows with failed captures; retention policy documented (hashes only, no bodies).
- The dedup key loses meaning across sources by construction — intentional: duplicates across lineages are *disagreements or confirmations*, both valuable, never collapsed.

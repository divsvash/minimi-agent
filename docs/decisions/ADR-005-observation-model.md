# ADR-005: Observations are distinct from Statements; immutable; Capture-backed

**Status:** Accepted

## Context
Change detection (pricing, releases, hosting costs, versions) needs: dimension-aware value comparison (annual vs monthly billing), honest handling of missing history, and proof of *what we saw when* — including the common case where a source page changes silently after we fetch it. Statements express beliefs with provenance; conflating fetched measurements into beliefs loses the source-data layer that verification depends on.

## Decision
`Observation` is a first-class, **immutable** node type separate from `Statement`:

- Statements may be `GROUNDED_IN` observations; they never replace them.
- Three timestamps with distinct semantics: `sourceEffectiveAt?` (source's claim about when the fact held; null if unstated — never inferred), `sourcePublishedAt?` (publication date; null if absent), `recordedAt` (capture time, always UTC — our ordering guarantee).
- Supersession of changed reality is expressed via `(:Observation)-[:SUPERSEDED_BY]->(:Observation)`; the superseded node is never mutated — no `status` field is rewritten.
- One `:Capture` per fetch (always, even when the fetched bytes match a known Observation): `(:Capture)-[:OBSERVED]->(:Observation)`. Two fetches → two Captures; identical re-fetch → new Capture, existing Observation (deduplicated by `obsKey`).
- `COMPARABLE_TO` is a derived, TTL-cached comparison result, never stored authority.
- `obs-norm/1` canonicalization (URLs, dimensions, timestamps, values, hashes) is pinned and versioned; bumps produce `normalization_mismatch`, never silent recomparison.

## Rejected alternatives
- **Overload Statement with `kind='observation'`:** collapses measurement vs belief distinction; dimension/hash machinery doesn't fit the statement lifecycle; `SUPERSEDES` semantics get muddy (statement supersession already means something else — user correction).
- **Overload Evidence with value/dimensions:** Evidence is a pointer (episode span or URL); adding normalized values, dims, and comparison logic turns it into a junk drawer and breaks the single provenance shape.
- **Mutable "latest observation" upsert:** destroys history; re-fetch would silently rewrite what we previously reported; contradicts the provenance guarantee; rejected hard. An earlier draft marked observations `status:'superseded_by_same_source'` by mutating the old node — replaced by the `SUPERSEDED_BY` relationship.
- **Dedup by ignoring captures (skip re-fetch writes):** loses the "we checked at time T and found X" evidence, making `verified_unchanged` unverifiable; rejected — Captures are the cheapest, highest-value audit artifact in the system.

## Consequences
- Two fact-bearing types to learn; mitigated by one shared Evidence spine and one `Researcher` API.
- Capture volume grows with refresh jobs (Slice 9); acceptable, and bodies are hashed, not stored, by default.
- `obs-norm` fuzz testing is mandatory (Slice 7); a canonicalization bug forks identity into phantom "changed" observations.

# ADR-003: Reified Statements; no bare fact edges

**Status:** Accepted

## Context
Memory requires: modality (asserted vs shortlisted vs rejected), polarity, who asserted with what authority, confidence, bitemporal bounds, supersession, conflict detection, and mandatory evidence links. All of this must be queryable with one consistent shape and enforced by constraints.

## Decision
Every fact is a first-class `(:Statement)` node connected via `SUBJECT`/`OBJECT` to entities. Entity↔entity fact edges (e.g., `(:User)-[:SHORTLISTED]->(:Entity)`) are forbidden except for structural edges (`PARTICIPATED_IN`, `ASSERTS`, `MERGED_INTO`, `OBSERVES`, `SUPERSEDES`, `CONFLICTS_WITH`).

## Rejected alternatives
- **Fact edges with properties:** property bags on relationships cannot express objectKind disjunction cleanly, force awkward partial indexing, make supersession/conflict tracking edge-local and non-navigable as first-class data, and prevent uniform Evidence attachment. This fails the requirements directly.
- **Triple/quad store style (S-P-O only, reification on demand):** pushes modality/time/authority into qualifier graphs; doubles join complexity for common queries; rejected same as above.
- **Document-per-statement in a side store (e.g., Mongo):** recreates the split-brain evidence join problem rejected in ADR-002.

## Consequences
- Node count roughly doubles; acceptable at personal scale and partially offset by uniform querying, mandatory `SUPPORTED_BY` constraints, and single-implementation temporal filtering.
- All retrieval, synthesis, eval, and correction tooling speaks one shape — measured by the fact that slices 3–8 share the same store API with zero special cases.

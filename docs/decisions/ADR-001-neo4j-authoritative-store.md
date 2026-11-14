# ADR-001: Neo4j as the initial authoritative store

**Status:** Accepted (initial — revisited only at a documented migration gate)

## Context
Minimi's correctness requirements are: transactional joins between episodes, statements, entities, and evidence; multi-hop traversal with temporal filters; provenance that is queryable, not assembled across stores; and a `npm run dev` story a reviewer can run cold. The workload is read-heavy traversal over a dense, small corpus (a personal memory), not analytical graph processing.

## Decision
Neo4j 5.x community edition is the single authoritative persistence layer. All memory writes commit there; the full graph + full-text legs are synchronously consistent with commits. Vector indexes are derived and rebuildable (ADR-011). Neo4j is used as a **property graph database**, not as a temporal database (it has no bitemporal semantics) and not as a "hybrid search engine" (its indexes provide no fusion) — those are application-layer responsibilities.

## Rejected alternatives
- **PostgreSQL + pgvector (+ Apache AGE or recursive CTEs):** strongest alternative. Loses on multi-hop provenance traversal ergonomics (CTE explosion for `Episode→Statement→Evidence→Entity` walks) and on Cypher's natural expression of as-of graph queries. Wins on operational familiarity — insufficient offset against the traversal-centric query load that dominates this challenge.
- **RDF/triplestore (e.g., Blazegraph, RDF4J):** standards-rich but property/document storage is awkward, vector support is non-existent, and tooling friction is high for a Node/TypeScript stack.
- **Embedded graph (Kuzu) + separate pipeline:** attractive for dev friction; rejected initially because ecosystem maturity, admin/ops tooling, and APOC-like extension surface are weaker; kept as a documented fallback if Neo4j licensing or Aura availability becomes a deployment blocker.
- **"Unified" framing of Neo4j doing everything alone:** rejected — see ADR-002 and ADR-011 for what is derived vs authoritative.

## Consequences
- One infrastructure dependency; backups and recovery revolve around `neo4j-admin dump` + replay-from-episodes.
- Community edition limits (memory, single instance) accepted; documented as in-scope risk (architecture.md §13).
- All access is funneled through the store module behind a `MemoryStore` interface — a future migration to Postgres or Kuzu is possible at a cost of rewriting the store layer only, not callers. This is a real option, not vapor: query patterns are simple enough to port, and no Cypher leaks past the store module.

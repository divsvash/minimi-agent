# ADR-011: Index consistency — full-text synchronous; vector excluded from same-transaction reads; no sleeps

**Status:** Accepted

## Context
Neo4j's two derived indexes behave differently with respect to transactions: full-text indexes are updated within the write transaction and are searchable on commit (when `dbms.index.fulltext.eventually_consistent=false`, the default), while vector indexes index asynchronously and **cannot see changes made within the same transaction**. Retrieval must not produce correctness failures because of this asymmetry, and must not paper over it with arbitrary sleeps.

## Decision

1. **Pin and assert:** `dbms.index.fulltext.eventually_consistent=false` is pinned via compose env and asserted in CI (the deployment refuses to start with the eventual-consistency mode enabled). Slice-1 integration tests prove immediate full-text visibility after commit so this behavior is pinned by test, not by assumption about a specific Neo4j version.
2. **Vector leg is excluded whenever it cannot be authoritative:** retrieval filters statements/episodes to `embeddingModel IS NOT NULL` (embedding job completed) and, in the same transaction as a write, never expects vector visibility. Correctness-critical reads (volatile claims, verification, `consistency=strong`) skip the vector leg entirely — existence and provenance are always decided by the graph + full-text legs.
3. **Read-after-write without delays:** same-session consistency is satisfied structurally (synchronous graph + FT legs; vector leg + hydrated evidence). Callers pass `?consistency=strong` to restrict retrieval to those legs; no `sleep()` exists anywhere in the codebase and CI fails on the pattern.
4. **Hybrid fusion is leg-tolerant:** RRF over whatever legs returned; a missing/empty leg contributes zero and never blocks. Stale vector entries cannot displace transactional graph/FT evidence in correctness-critical paths.
5. **Rebuildability:** `npm run rebuild:indexes` is a batched, job-tracked, idempotent drop/refill of vector and full-text indexes — the recovery and embedding-upgrade path, not a crutch for ignoring consistency.

## Rejected alternatives
- **Naive dual-dependency on both indexes:** immediate failure on write-then-read; rejected by construction.
- **Sleep-based "eventual consistency" (wait N ms after write):** nondeterministic, test-hostile, and hides the asymmetry rather than handling it. Banned.
- **Forcing transactional vector behavior via post-commit blocking:** would couple write latency to embedding cost and still not guarantee same-tx visibility inside the caller's transaction; rejected.
- **Abandoning the vector leg for synchronous-only retrieval:** sacrifices semantic recall, the system's core value; rejected — exclusion is scoped to correctness-critical reads only.

## Consequences
- `consistency=strong` exists as a documented, cheap correctness mode; default reads stay hybrid for quality.
- CI test suite includes the asymmetry assertion (same-tx vector miss vs graph/FT hit) — a deliberately odd-looking test that protects the design's most subtle guarantee.
- Migration docs and the README state the configured `eventually_consistent=false` so operators don't "optimize" it away.

# ADR-002: No separate vector (or dedicated search) database

**Status:** Accepted

## Context
Semantic retrieval needs nearest-neighbor search over statement/episode embeddings. Neo4j 5 ships a native HNSW vector index; Qdrant/Weaviate/Pinecone/etc. offer stronger hybrid features (learned fusion, metadata filters, quantized indexes at scale).

## Decision
Use Neo4j's native vector index as the vector leg of retrieval, behind a `VectorIndex` interface. A separate vector/search database is **not** introduced at any slice.

## Rejected alternatives
- **Separate vector DB (Qdrant/Weaviate):** wins on raw ANN performance and native hybrid search; loses on: (a) dual-write consistency — a fact can exist without an embedding (invisible to semantic recall) or vice versa (unattributable), without a reconciliation process we would then have to build and monitor; (b) evidence joins across stores become network hops with partial-failure modes — fatal for a provenance-first product; (c) two systems to pin, back up, and explain in a public eval deployment; (d) zero payoff at personal-corpus scale (~10⁴–10⁶ vectors), where HNSW in Neo4j is comfortably sufficient.
- **Dedicated search engine (Elasticsearch/OpenSearch):** duplicates what Neo4j full-text (Lucene) already provides transactionally; adds a JVM-class operational burden.
- **Postgres full-text + pgvector as *replacement* for Neo4j:** see ADR-001.

## Consequences
- Vector results are best-effort freshness and are **excluded from correctness-critical reads** (volatile claims, `consistency=strong`); the transactional graph/full-text legs always decide existence and provenance (ADR-011).
- Embedding model changes require re-embedding via `npm run rebuild:indexes` — scheduled, resumable, idempotent (architecture.md §8).
- The `VectorIndex` interface keeps a future split (e.g., if corpus grows two orders of magnitude) a module swap, not a redesign.

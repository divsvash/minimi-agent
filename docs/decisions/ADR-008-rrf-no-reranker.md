# ADR-008: Reciprocal Rank Fusion; no reranker initially; tunable seam

**Status:** Accepted

## Context
Three retrieval legs (vector, full-text, graph expansion) return incomparable score scales; fusion method determines whether hybrid actually beats its best leg. A cross-encoder reranker could lift precision but adds a model dependency, latency, and training-data hunger.

## Decision
v1 fusion is **RRF** (`score = Σ 1/(60 + rank)` across legs), followed by a post-fusion prior: `final = rrf × 1/(1 + 0.3·hops)` (evidence-distance decay) and a recency multiplier for volatile predicates. Graph-leg budget enforced (≤2 hops, ≤64 nodes/branch, ≤200 visited, edge-type whitelist). Output top-k (leg k=20 → fused → k=8 to synthesis). **No reranker is built or vendored.** A `Ranker` interface seam exists; a cross-encoder is added only if Slice 10 baselines show hybrid underperforming on targeted classes with a measurable reranker gain, decided on eval evidence.

## Rejected alternatives
- **Weighted score addition across legs:** score scales are incomparable (cosine vs Lucene BM25 vs hop penalty); weights become untunable magic constants. Rejected.
- **Learned fusion (LTR model):** no training signal available and none will be until usage logs exist; training on our own golden set to evaluate on it is circular. Rejected until data exists.
- **Mandatory cross-encoder reranker:** adds 50–300ms + a model artifact + version pinning for an unproven gain at our corpus density; violates "optimize how, not whether" by adding moving parts before evidence of need. The seam keeps the door open at zero structural cost.
- **Graph results appended after fusion (not fused):** breaks score comparability; graph evidence disappears behind vector noise; rejected.

## Consequences
- Retrieval quality is bounded by leg quality; leg failures degrade gracefully (absent leg contributes zero).
- k=60 and α=0.3 are documented constants; Slice 10 reports sensitivity runs, not silent retunes.
- If a reranker is introduced later it lives behind `Ranker` and defaults off — no caller changes.

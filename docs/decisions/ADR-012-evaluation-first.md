# ADR-012: Evaluation-first sequencing; fixtures, baselines, reproducibility from Slice 2

**Status:** Accepted

## Context
The challenge grades — among other things — whether the system demonstrably works and whether results are reproducible. Retrofitting evaluation after implementation produces either theater (tests that pass because the implementation grew to fit them) or collapse (nothing is measurable). Determinism is threatened by LLMs and live web access, which must be fenced by recorded fixtures.

## Decision

1. **The eval harness ships in Slice 2**, alongside contracts and fakes — before any behavior exists — with: JSONL golden cases; a matcher DSL (`expectStatementIds`, `expectVerbatimFragment`, `expectVerdict`, `expectCitationSpanValid`, `expectNoAssertionWhenInsufficient`); a fixture registry (recorded HTTP for search/fetch; in-memory fakes for LLM/embeddings); metrics collectors (recall@k, MRR, citation precision, verdict accuracy, false-no-change safety rate, p50/p95 latency, tokens/query); deterministic mode (pinned model ids, temperature 0, fixed seeds — CI runs fully offline).
2. **Every slice adds its golden cases** as part of its acceptance criteria (architecture.md §11 lists per-slice cases; Slice 3 extraction fidelity, Slice 4 five-distinct-CRM entities, Slice 5 as-of boundary, Slice 6 citation precision, Slice 7 full verdict matrix, Slice 8 end-to-end challenge examples).
3. **Slice 10 is comprehensive evaluation only**: baseline matrix (vector-only / graph-only / hybrid), full metrics, regression thresholds in CI, `docs/eval-results.md` with committed numbers, reproducibility protocol (fixture replay, pinned versions, runbook), and a **holdout set** disjoint from developer-visible cases to detect golden-set overfitting.
4. **Hybrid is declared better only on evidence:** hybrid must beat both single legs on the agreed classes with ≥ citation-precision target and zero false-no-change escapes; otherwise the simpler winning leg ships and the report says so. The eval, not the architecture diagram, decides.

## Rejected alternatives
- **Evaluate at the end (original plan had eval in Slice 10 only):** defers the only feedback loop that prevents confidently-wrong memory; rejected — Slice 2 introduction is a hard requirement of this design.
- **Live-web eval runs:** nondeterministic, unreplayable, costly; the wire-level truth of eval is the fixture, not the internet. Live smoke tests may exist separately, never as gates.
- **Single "it works" demo transcript instead of golden metrics:** unfalsifiable; fails the reproducibility bar; rejected.
- **Eval set fully visible to implementers (no holdout):** silent overfitting to 35 hand-picked cases; holdout mitigates — methodology honesty is part of the submission.
- **Auto-generated golden cases from the LLM under test (self-grading):** circular; cases are hand-authored from the challenge spec plus failure modes.

## Consequences
- Slice 2 is heavier than a "scaffolding" slice — deliberately: it buys permanent leverage (every later slice ships with its definition of done).
- Fixture maintenance burden is real; fixture-drift hashes fail loudly rather than degrading to mystery.
- CI gains a regression gate (smoke subset) so architectural regressions (e.g., a query losing its as-of filter) fail the build, not the review.

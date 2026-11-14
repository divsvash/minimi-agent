# ADR-009: Research verdicts — the system never claims "unchanged" without sufficient evidence

**Status:** Accepted

## Context
Change detection is the feature most likely to lie confidently: search returns nothing and an LLM concludes "nothing changed." That conclusion is unsupportable — absence of search results is evidence about search, not about the world. Factual honesty is the product differentiator and the grading criterion for this challenge.

## Decision
Research emits exactly **four verdicts** (what research established), accompanied by a separately-typed **ComparisonOutcome** (whether two observations are comparable at all):

- `changed` — current observation, comparable dimensions, normalized values differ (both captures attached).
- `verified_unchanged` — current observation, comparable, values equal (both captures attached).
- `no_change_found` — research executed, sources visited, but nothing establishes the attribute's current value (page redesigned, login wall, extraction failure, dimension mismatch only).
- `insufficient_evidence` — no usable source at all (empty search, all fetches failed, entity unresolvable).

`ComparisonOutcome`: `comparable | dimension_mismatch{mismatchedKeys[]} | normalization_mismatch{versions}` — computed *before* verdicts; mismatch never produces a verdict of its own, and never authorizes a comparison difference.

Rules enforced in code and tests: **absence of evidence is never reported as absence of change**; no-change language requires a current capture; conflicts are surfaced, never averaged; missing history yields explicit "baseline unknown." Every verdict carries its `:ResearchRun` (queries issued, sources visited/failed, coverage status) so answers can show their work. Applies identically to pricing, software releases, hosting costs, and feature availability.

## Rejected alternatives
- **Three-state verdict (changed / unchanged / unknown):** "unchanged" is precisely the claim we must refuse without a current capture; collapsing `no_change_found` and `verified_unchanged` into one state destroys the distinction the whole subsystem exists to protect. Rejected.
- **`dimension_mismatch` as a fifth verdict:** misconflates "research outcome" with "comparison precondition failure"; an annual-vs-monthly comparison is not a research result, it is a refused comparison — typed separately (Correction 2 of the final review pass).
- **Similarity/majority voting across sources to declare unchanged:** manufactures false confidence from correlated low-quality sources; conflicts are presented, not voted away.
- **Trusting vendor pricing page fetch without recording coverage:** "we failed to parse it" would masquerade as "nothing changed." Rejected via mandatory ResearchRun coverage accounting.
- **Currency conversion to force comparability:** FX math without a dated source is fabrication; mismatch stands, values shown raw.

## Consequences
- More "unknown" answers than a confident-sounding system would give — by design, and stated as such in the README and eval report.
- Synthesis must render verdicts with certainty language and failed-query transparency; prompt discipline is tested by golden cases (Slice 8, false-no-change trap = zero tolerance).
- `verified_unchanged` claims are auditable end-to-end (two captures + comparable dims), which is the strongest honest statement available about an external fact at time T.

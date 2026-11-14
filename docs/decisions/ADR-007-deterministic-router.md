# ADR-007: Deterministic router first; LLM planner constrained, validated, no agent loop

**Status:** Accepted

## Context
Query classes differ radically in determinism: "what did I ask on 3 November?" is a date parse + index lookup; "is it still correct?" needs judgment about volatility; "what do I usually do?" needs semantic recall. A uniform LLM planner per query adds latency and cost and — critically — nondeterminism that defeats eval reproducibility.

## Decision
A rule-based router classifies every query into Q1–Q6 before any LLM call. Deterministic flows: Q1 (date parser + Episode query), Q4 (predicate/modality whitelist graph query), Q3 skeleton (entity+attribute resolution is deterministic; semantics come from the research engine). An LLM planner is invoked only for Q2 (volatile-claim extraction), Q3-adjacent disambiguation, and Q5-ambiguous scope, and must emit exactly `{class, asOfValid?, asOfTx?, entities[], predicates[], hops≤2, timeRange?, needsVerification}` which is schema-validated: enums enforced, entities resolved-or-flagged, hops clamped, time ranges must parse. Two retries; on persistent failure the plan degrades to the Q5 default (`asOf=now`, hops=1) with a `planner_fallback` metric — never to unconstrained planning. **No agent loop, no tool-calling chains, no multi-step self-directed plans.**

## Rejected alternatives
- **Agent loop with tools (the "agentic memory" pattern):** unverifiable trajectories, unreproducible eval, latency/cost blowup, prompt-injection surface from fetched web content into the planner. Rejected for this product's correctness bar.
- **LLM planner for all classes:** pays 300–800ms + tokens for queries a regex answers, and injects nondeterminism into Q1/Q4 which must be stable for history-recall claims.
- **Purely deterministic parsing of everything:** cannot express volatile-claim extraction ("pricing page may have changed") or fuzzy semantic intent; false economy.
- **Plan cache (memoized plans):** deferred — measure first (architecture.md §12); adds invalidation complexity before evidence of need.

## Consequences
- Two planner implementations coexist (router + optional LLM fallback) with one output contract — every downstream stage consumes identical `RetrievalPlan`.
- `planner_fallback` rate is a tracked health metric; rising values indicate router grammar drift.
- Injected web text reaches only the extractor/synthesizer with citation constraints, never the router — an explicit firewall property.

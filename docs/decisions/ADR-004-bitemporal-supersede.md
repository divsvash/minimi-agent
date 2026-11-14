# ADR-004: Bitemporal model; supersede, never update

**Status:** Accepted

## Context
Challenge questions require both "what did I ask on 3 November?" (valid time) and "what did we believe then / is it still correct?" (transaction time). New information (corrections, price changes) must not destroy the state of knowledge at earlier times. Retroactive edits are the canonical bitemporal bug.

## Decision
Two independent axes on every Statement: `validFrom`/`validTo` (world-time; `validTo=null` ⇔ still true as far as known) and `recordedAt`/`supersededAt` (knowledge-time). Corrections create a new Statement with `SUPERSEDES`; the old statement gets exactly two post-creation fields set — `supersededAt`, `supersededBy` — and `status='superseded'`. Content is never edited. Retraction sets `status='retracted'`. Conflicts keep both statements with `CONFLICTS_WITH` and are surfaced, never resolved by the system.

## Rejected alternatives
- **Single `updatedAt` timestamp:** cannot answer "is the answer still correct" or "what did we believe on 3 Nov"; destroys history on correction. Rejected outright.
- **Valid-time only (classic temporal DB):** adequate for "where did I work in 2024" but loses "what did we know when", which the audit/eval story needs.
- **In-place updates with an audit log table:** split-brain again (truth in one place, history in another); queries must union both — rejected per ADR-001/002 consistency reasoning.
- **Dedicated temporal extension/library:** none exists at the needed semantic level for property graphs; application-layer `TemporalFilter` is the enforcement point — and it is written once, property-tested once (Slice 5).

## Consequences
- Storage grows monotonically; compaction is a non-goal (memory of "wrong beliefs" is itself valuable for provenance and eval).
- Every temporal query must pass through `TemporalFilter`; ad-hoc interval Cypher elsewhere is a review-blocking defect.
- `timePrecision` and IANA tz handling make day-precision boundaries correct across DST — a common silent failure in naive implementations.

# ADR-004: Bitemporal model; immutable content; append-only lifecycle

**Status:** Accepted (refined — supersedes the earlier "supersede with mutated status fields" description)

## Context
As before, two axes are required. But the first draft of this ADR violated its own principle by mutating `supersededAt`, `supersededBy`, `status` on the corrected Statement. This ADR now distinguishes **immutable claim content** from **lifecycle history**, and derives current status from events.

## Decision

### Immutable content vs lifecycle
Every `(:Statement)` has **immutable content** (subject, predicate, object, polarity, modality, authority, confidence, extraction metadata, time axes, precision) — never edited after creation. Lifecycle is **append-only**:

- `:LifecycleEvent` nodes (`kind`: `superseded | retracted | conflicted | resolution_contested`, plus `at`, `actor`, `reason`, references) connected by `:SUPERSEDES` / `:RETRACTS` / `:CONFLICTS_WITH` edges to the affected statements.
- **`status` on Statement exists only as a projection** (`active | superseded | retracted | conflicted`) maintained for query ergonomics. It is *derived* from the event log: recomputed by a validator (`npm run memory:check`) which replays events and asserts the projection matches; projections can be dropped and rebuilt from events at any time (`npm run memory:rebuild-projections`). Any divergence fails the check. No query may treat the projection as the source of truth for history — it is a cache with a verification harness.
- No `supersededAt`/`supersededBy` fields on the statement node; supersession time lives on the event/edge (queryable, indexed, and honest about ordering).

### Time axes — no field overloading
`validTo = null` is **never** used to mean multiple distinct things. A statement carries:

- `validFrom: datetime?` — lower bound of the world-time interval. `null` ⇔ **unknown valid-time start** (not "epoch", not "now").
- `validTo: datetime?` — upper bound. Three explicitly distinct situations, disambiguated by an enum `validity`:
  - `bounded` — both bounds set (point-like facts use equal bounds).
  - `open_ended` — `validFrom` known, `validTo = null`: **known start, no known end** ("employed at X from March 2024, end not established").
  - `ongoing` — `validFrom` known, `validTo = null`, and the source/extraction asserted *explicit continuance* ("still works there") rather than mere absence of an end date. Distinguishing `open_ended` from `ongoing` keeps "we never learned the end" separate from "the source just now claimed continuance" — different evidential weight, different synthesis wording ("as of <access date>, still X" vs "since X, no end recorded").
  - `unknown_end` variant is folded into `open_ended` by design; any caller needing stronger semantics uses `ongoing` only with explicit evidence.
- **Retracted** and **superseded** are *lifecycle states derived from events* (not interval states) — expressed only via the projection from `:LifecycleEvent` history.

All as-of queries branch on these explicitly inside `TemporalFilter`; ad-hoc null checks elsewhere are review-blocking.

## Rejected alternatives
- **Supersede via in-place field mutation (prior draft):** violates immutability, makes replication/backup restore order-dependent for correctness, breaks the "history is append-only" audit guarantee. Rejected.
- **Status as fact (only events, no projection):** every query grows a derivation join; acceptable in theory, rejected for ergonomics — projection + validated rebuild is the pragmatic middle.
- **Single timeline with convention (`validTo=null` meaning "still true"):** conflates unknown-end with ongoing with never-started; explicitly called out as the failure this ADR fixes.
- **Retraction via flag with no event:** loses who/when/why; unauditable; rejected.

## Consequences
- One additional node type (`LifecycleEvent`) and one projection to maintain/validate — modest cost for real immutability.
- `memory:check` becomes a mandatory CI gate (projection consistency, interval invariants, event referential integrity).
- Synthesis wording differs by `validity` — the model must say "ongoing (confirmed <date>)" ≠ "open-ended (end not recorded)"; tested in golden cases.

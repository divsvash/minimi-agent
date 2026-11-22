# Minimi — Architecture

Minimi is a conversational agent with persistent, temporal, and relational memory. This document is the authoritative architecture reference. Decisions are recorded as ADRs in `docs/decisions/` (ADR-001 … ADR-012); each records context, decision, rejected alternatives, and consequences — not merely a restatement of this document.

Status: **Slices 1–2 shipped and verified; Slice 3 implemented and offline-verified** (extraction → statements; real-Neo4j integration run pending explicit approval — see §11 and README). Slices 4–11 are planned, not built. This document and the ADRs remain the source of truth for design.

---

## 1. Design principles

1. **Memory is the product.** The graph is not a cache of a vector store; evidence joins transactionally in one store (ADR-001).
2. **Raw conversation is sacred.** Episodes are persisted synchronously and verbatim before anything else; all other memory is derived and rebuildable (ADR-010, ADR-011).
3. **Provenance is non-negotiable.** Every fact in an answer traces to an `Evidence` span (episode) or a `Capture` (external fetch). No claim without a source pointer.
4. **No overwrites.** Corrections supersede; retractions retract; conflicts are surfaced, never silently resolved. History is append-only at the node level (ADR-004, ADR-005).
5. **Similarity is not identity.** Embedding scores generate candidates; they never authorize merges (ADR-006).
6. **No verdict without evidence.** The system refuses to assert "unchanged" unless a current observation was captured and dimension-compared (ADR-009).
7. **Engineering efficiency, not minimalism or maximalism.** One deployable monolith, one infrastructure dependency (Neo4j), shared services, provider interfaces, deterministic-first routing.
8. **Evaluation is built with the system, not after it** (ADR-012).

## 2. System shape

```
User ─► Web UI ─► API (chat, sessions, corrections, entity admin, jobs/dead)
                    │
   ┌────────────────┼─────────────┐
   ▼                ▼             ▼
 Ingestion      Retrieval      Answer synthesis
 (router +      (hybrid +      (LLM + citations,
  planner)       RRF + as-of)   certainty language)
   │                ▲             │
   ▼                │             ▼
 Validator ──► Resolver ◄── Researcher ──► Search → Fetch → Extract → Normalize
   │                │           (advisory verification,    │
   ▼                ▼            never auto-rewrites)      ▼
        Neo4j (authoritative store)                 Observations + Captures
   Episode · Statement · Entity · Observation · Evidence · Capture · Job
   Constraints + full-text (synchronous) · vector index (derived, excluded from same-tx reads)
                    │
        Eval harness (offline, fixture replay, baselines incl. vector-only / graph-only / hybrid)
```

**One process.** Ingestion, retrieval, synthesis, research, and jobs run in a modular TypeScript monolith with in-process workers; Neo4j `:Job` nodes are the job ledger (ADR-010). No broker, no microservices, no separate vector store (ADR-002).

**Module layout (logical):**
`core/` (contracts, clock, ids, telemetry) · `memory/` (stores, TemporalFilter) · `ingestion/` (outbox, extraction, validation, resolution) · `retrieval/` (router, planner, retrievers, RRF) · `research/` (discovery, fetch, extract, normalize, compare) · `reasoning/` (recall, verify-answer, change-detection, entity-recall, semantic flows) · `synthesis/` · `eval/` · `jobs/` · `interfaces/` (neo4j, llm, embeddings, search, fetch — all provider-agnostic with in-memory fakes).

## 3. Data model

Authoritative nodes: `User`, `Episode`, `Entity`, `Statement`, `Observation`, `Evidence`, `Capture`, `Job`, plus audit nodes (`MergeEvent`, `SplitEvent`, `LifecycleEvent`, `ResearchRun`, `UnresolvedEntity`). Derived: vector index, full-text indexes, cached `COMPARABLE_TO` (TTL-only, never authoritative — §6.3), the `Statement.status` projection (rebuilt from lifecycle events — §3.4).

### 3.1 `(:User)` — single-tenant by design (documented scope decision)
`id` (`user:local`), `displayName`, `createdAt`, `timezone` (IANA — required for interpreting “3 November”, “last Monday”).

### 3.2 `(:Episode)` — raw, verbatim, the unit of recall
| property | meaning |
|---|---|
| `id` | uuid |
| `externalId` | **Identity contract:** if an upstream `messageId` exists, `sha256("msg\|" + sessionId + "\|" + messageId)`; otherwise `sha256("content\|" + sessionId + "\|" + role + "\|" + text + "\|" + occurredAt)`. Upstream ids win — genuinely identical turns in one session are distinct only with a `messageId`; without one, byte-identical re-deliveries are idempotent re-sends of a single logical turn. **Unique constraint.** Separately, `(sessionId, seq)` carries a **unique constraint**; `seq` is allocated via a per-session sequencer node locked inside the ingest transaction (`:SeqGuard`), so concurrent ingestions serialize and cannot collide (guarded by `0002_session_sequence_unique`) |
| `sessionId`, `seq`, `role` | conversation structure |
| `text` | raw, immutable |
| `occurredAt` + `precision` + `tz` | when the turn happened; precision ∈ `second\|minute\|day\|month\|year\|unknown` |
| `source` | `chat\|api\|import` |
| `createdAt` | recorded time |

Recall queries hit Episodes first and never route through embeddings.

### 3.3 `(:Entity)` — canonical identity
`id` (never name-derived), `type` (`person\|org\|product\|concept\|place\|event\|team`), `canonicalName`, `aliases[]` (normalized), `externalIds?`, `status` (`active\|merged\|contested\|split`), `createdAt`, `updatedAt`. Multi-label (`:Entity:Product`) with `:Entity` shared label for cross-type queries.

### 3.4 `(:Statement)` — reified claim (not an S-P-O tuple)
| group | properties |
|---|---|
| Subject/Object | `subjectId` → Entity; `objectKind`: `entity\|literal`; `objectId` → Entity if entity, else `objectValue` (string/number/bool/date); optional `predicateQualifier` map (e.g. `{for: "crm", context: "20-person sales team"}`) |
| Polarity / modality | `polarity`: `positive\|negative`; `modality`: `asserted\|considered\|shortlisted\|rejected\|uncertain\|proposed\|decided` — controlled vocabulary |
| Authority | `assertedBy`: `user\|assistant\|extraction\|external_verification`; `epistemicStatus`: `user_asserted\|model_inferred\|externally_verified\|user_corrected` |
| Confidence | `confidence` (float) — **extraction confidence only; never a truth score; never averaged across statements** |
| Extraction metadata | `extractionModel`, `extractionPromptHash` |
| Valid time | `validFrom` (null ⇔ **unknown valid-time start** — never epoch/now), `validTo` (upper bound only), `timePrecision`, and `validity`: `bounded | open_ended | ongoing` — distinguishing *known start, no known end* (`open_ended`) from *source-asserted continuance* (`ongoing`); there is no single null conflation (ADR-004) |
| Recorded time | `recordedAt` |
| Lifecycle | **Append-only events**, not fields: `:LifecycleEvent` (`superseded | retracted | conflicted | resolution_contested`) + `SUPERSEDES`/`RETRACTS`/`CONFLICTS_WITH` edges. The `status` property exists **only as a rebuildable projection** (derived from the event log; `npm run memory:check` replays events and validates the projection; `npm run memory:rebuild-projections` rebuilds it). Immutable content is never edited after creation (ADR-004) |

Subject–predicate–object is carried by `SUBJECT`/`OBJECT` relationships to Entities; everything else lives on the Statement. **There are no bare entity↔entity fact edges** (ADR-003).

### 3.5 `(:Observation)` — immutable measurement from the outside world
| group | properties |
|---|---|
| Identity | `id`, `obsKey` (`sha256(subjectId \| attribute \| dimHash \| canonicalUrl \| sourceEffectiveAt \| sourcePublishedAt \| valueHash \| obsNormVersion)`) |
| What/where | `attribute` (controlled vocab: `pricing.amount`, `pricing.plan`, `software.version`, `hosting.cost`, `feature.availability`, …); `dimensions` map (`plan`, `billingPeriod`, `edition`, `currency`, `region`, …) |
| Value | `value` (normalized scalar/JSON), `unit` |
| **Time — three distinct axes** | `sourceEffectiveAt?` (when the source claims the fact held; null if unstated — never inferred) · `sourcePublishedAt?` (publication date; null if absent) · `recordedAt` (**capture time, always set, UTC — our ordering guarantee**) |
| Provenance | `source: { url, title, publisher, publishedAt?, accessedAt }`, `extractionMethod` (`api\|selector\|structured_llm\|manual`), `extractionConfidence` |
| Versioning | `obsNormVersion` pinned (§9); **nodes are immutable — no field is ever updated after creation** |

Supersession of changed external reality is expressed as **`(:Observation)-[:SUPERSEDED_BY]->(:Observation)`** (relationship + properties `detectedAt`, `researchRunId`, `reason`), **never by mutating the old node**. “Current” = not superseded. “History” = chain traversal.

**Supersession is same-lineage only, and never by recency alone** (ADR-005): lineage = explicit `sourceId` — resolved by configured source identity first, then publisher identity, then canonical host, then explicitly declared source family; URL movement does not break lineage. A newer capture supersedes an existing observation only when it is a *genuine replacement* — successor `sourceEffectiveAt` ≥ superseded one’s (or explicit withdrawal/deprecation) **and** the extracted value differs in the comparable dimension set. Same value + newer date ⇒ new Capture on the existing Observation, not supersession. Disagreeing sources in different lineages are never superseded; both stand (`CONFLICTS_WITH`). Effective-period-separated observations in one lineage are complementary, not superseding.

**Capture** (`:Capture`) — one per fetch attempt, always:
`id`, `fetchedAt`, `sourceUrl` (canonicalized), `outcome` (`ok|http_error|timeout|parse_error|blocked`), `httpStatus?`, `errorKind?`, `bodyHash?` (only when `outcome='ok'`), `extractedFieldHashes?`, `jobId`. Fetches of unchanged pages create new Captures referencing the *same* Observation via `(:Capture)-[:OBSERVED]->(:Observation)` — two fetches, two Captures, one deduplicated Observation. **Failed fetches produce a Capture with no `OBSERVED` relationship** and feed `ResearchRun` coverage accounting; they are never silently dropped. Captures are the proof of what we saw (or failed to see) even if a page later changes, and the replay input for eval.

### 3.6 `(:Evidence)` — the single provenance spine
`id`, `kind`: `episode_span\|external_url\|document`, `episodeId?`, `messageExternalId?`, `spanStart?`, `spanEnd?` (UTF-16 code units into `Episode.text` — documented), `quote?` (denormalized span, audit-friendly), `url?`, `accessedAt?`, `captureId?` (links to the Capture for external evidence).

### 3.7 Relationships
```
(:User)-[:PARTICIPATED_IN]->(:Episode)
(:Episode)-[:ASSERTS]->(:Statement)
(:Statement)-[:SUBJECT]->(:Entity)          (exactly one)
(:Statement)-[:OBJECT]->(:Entity)           (only when objectKind = entity)
(:Statement)-[:SUPPORTED_BY]->(:Evidence)   (1..n — mandatory)
(:Statement)-[:SUPERSEDES]->(:Statement)
(:Statement)-[:CONFLICTS_WITH]->(:Statement)
(:Statement)-[:GROUNDED_IN]->(:Observation) (for externally verified claims)
(:Observation)-[:OBSERVES]->(:Entity)
(:Observation)-[:SUPPORTED_BY]->(:Evidence)
(:Observation)-[:SUPERSEDED_BY]->(:Observation)
(:Capture)-[:OBSERVED]->(:Observation)   // absent for failed fetches
(:Entity)-[:MERGED_INTO]->(:Entity)
(:Episode)-[:PENDING_EXTRACTION]->(:Job)
(:LifecycleEvent)-[:TARGETS]->(:Statement)        // audit backbone; emitted together with SUPERSEDES/RETRACTS edges
```
No other fact-bearing edges exist. Audit nodes (`MergeEvent`, `SplitEvent`, `LifecycleEvent`) preserve history of identity and lifecycle changes; the `Statement.status` projection is always rebuildable from the latter.

### 3.8 Worked examples against the hiring-challenge cases
**A — shortlisted five CRMs for a 20-person sales team.** Episode (verbatim) → statements: five `predicate="shortlisted", modality="shortlisted", epistemicStatus="user_asserted", validFrom=<day precision>`, each `SUPPORTED_BY` a span covering the tool name; plus `predicate="has_size", objectValue=20, qualifier={context:"sales team"}`. Entity recall query = `predicate='shortlisted' AND modality='shortlisted' AND status='active'` as-of now → exactly the five, attributed, dated, retractable.

**B — “Is Postgres in-house hosting worth it?” asked 2026-11-03.** One Episode (`occurredAt=2026-11-03T14:22:00Z`). One statement `predicate="asked_about"`. The answer’s claims are separate statements with `epistemicStatus="model_inferred"` until verification runs; if research runs, claims become `externally_verified` with `GROUNDED_IN` observations and `SUPPORTED_BY` external Evidence (url + `accessedAt`).

**C — “What did I ask on 3 November, and is the answer still correct?”** Two distinct flows:
1. **Recall** (deterministic, no LLM): `Episode WHERE occurredAt ∈ [2026-11-03T00:00, 2026-11-04T00:00) in user tz` → verbatim. Provenance = episode itself.
2. **Verification**: statements from that episode → volatile claims extracted (schema-validated) → `Researcher.observe(each)` → compare vs stored baseline → per-claim status. Output: “On 3 Nov you asked about Postgres hosting. My answer then recommended managed Postgres. As of <today>: <current pricing/version facts, each with capture-dated sources> — <verdict + certainty + what remains unverifiable>.”

## 4. Time semantics — precise rules

- All times stored as UTC `datetime`. Episode additionally stores local wall-clock + IANA tz for display (“3 November” only parses in the user’s tz).
- **Precision is a property, not a convention.** Day-precision bounds are `[00:00, 24:00)` in the user’s tz converted to UTC (DST-aware). Month/year similar. Never assume second precision from a value.
- **Unknown dates:** `validFrom = null` means unbounded/unknown — never epoch, never “now”. All queries branch on null explicitly inside `TemporalFilter` (the *only* place interval semantics are implemented; nothing else re-implements them).
- **Open intervals:** `validTo = null` ⇔ no end established; “Current” predicate: `validTo IS NULL OR validTo > asOf` ∧ transaction-time bound from the lifecycle event log (latest superseding/retracting `LifecycleEvent.at`), injected by `TemporalFilter`. Never interpreted bare — `validity` (bounded/open_ended/ongoing) disambiguates by definition (ADR-004).
- **Two as-of axes, always named:** `asOfValid` (state of the world then) and `asOfTx` (knowledge then). Recall uses valid-time; “what did we believe on 3 Nov” uses transaction-time. Contracts name the axis explicitly (`activeAt(asOfValid?, asOfTx?)`).
- **`validity` disambiguates open intervals:** `bounded` (both bounds), `open_ended` (known start, end never established — "since March 2024, no end recorded"), `ongoing` (source explicitly asserted continuance as of access date — "still employed there as of <date>"). `validTo = null` alone is ambiguous by design and is never interpreted without `validity`.
- **Never overwrite history.** Correction = new Statement + `LifecycleEvent(kind=superseded)` + edge; retraction = `LifecycleEvent(kind=retracted)`; conflict = both kept + `CONFLICTS_WITH` + surfaced. The `status` projection is rebuilt from events and validated; content nodes are never edited after creation.
- `timePrecision` travels with every statement so synthesis can say “around November 2026” instead of inventing a date.

## 5. Retrieval and planning

### 5.1 Query classes and deterministic-first routing
| class | example | plan |
|---|---|---|
| Q1 Exact historical recall | “What did I ask on 3 November?” | Deterministic date parse (parser + user tz; ambiguous → LLM-assisted parse, schema-validated) → Episode query. No retrieval LLM. |
| Q2 Historical answer verification | “Is that answer still correct?” | Q1 recall → StatementStore.activeAt → volatile-claim extraction (validated) → `Researcher` per claim → diff vs baseline → structured verdict per claim. |
| Q3 Change detection | “Has pricing changed since Monday?” | Deterministic entity+attribute resolution → baseline observation vs fresh `Researcher.observe(...)` → ComparisonOutcome → Verdict (§6.4). |
| Q4 Entity/decision recall | “Which CRM tools did we shortlist?” | Deterministic: predicate whitelist + `modality='shortlisted'`, `status='active'`, as-of now; rank by confidence × recency × salience. |
| Q5 General semantic memory | “What do I prefer about deploys?” | Hybrid retrieval (§5.2) + synthesis; deterministic entity linking; LLM planner only for genuinely ambiguous scope. |
| Q6 Verification override | “Are you sure?” | Attach advisory `Researcher` per factual claim → rewrite with per-claim status. |

**Planner LLM (Q2/Q3/Q5-ambiguous only)** must emit: `{class ∈ enum, asOfValid?, asOfTx?, entities[], predicates[], hops ≤ 2, timeRange?, needsVerification: bool}`. Validated: enums checked; entities resolve to ids or are flagged `unresolved_new`; hops clamped ≤2; timeRange must parse. Two retries → safe default (Q5 plan, `asOf=now`) → `planner_fallback` metric. **No agent loop, no unrestricted tool use, no multi-turn planning.** Plan cache is deferred (§12).

### 5.2 Hybrid retrieval (one shared pipeline)
Legs execute in parallel: (1) vector top-k over statement/episode embeddings (model-tagged; pending embeddings excluded), (2) full-text top-k (Lucene, BM25), (3) graph expansion — 1–2 hops from resolved entities along Statement/Evidence/Entity edges with edge-type whitelist and budgets (≤64 nodes/branch, ≤200 visited, α-decay by hop). Fusion: **Reciprocal Rank Fusion** (`Σ 1/(60 + rank)`) over legs, then post-RRF prior `final = rrf × 1/(1 + 0.3·hops)`, plus recency multiplier for volatile predicates. The store layer injects the as-of filter into *every* leg — callers cannot forget it. Output = `EvidenceBundle { statements, episodes, entities, scores{vector,fulltext,graph,rrf}, planHash }` — synthesis cites from this, eval measures it.

Top-k defaults: 20 per leg → RRF → 8 to synthesis. **No reranker in v1** (ADR-008); a `Ranker` seam exists so one can be added when eval proves the need.

### 5.3 Consistency between legs and writes
Full-text and graph legs are synchronous with commits (§8). Vector leg may lag; correctness never depends on it. `?consistency=strong` skips the vector leg. No sleeps anywhere (ADR-011).

## 6. Research subsystem (first-class)

### 6.1 Pipeline
```
ResearchRun accounting (mandatory, attached to every verdict): { id, entity, attribute, dims, queries[], startedAt, completedAt,
  attempts[]: [{query?, url?, sourceId, outcome, relevant, accessible, attrExtracted,
                dimsComparable?, value?, sourceEffectiveAt?, sourcePublishedAt?,
                authoritative, fresh, conflictWith?}],   // per-attempt records are authoritative;
  // aggregate flags derived from attempts[] (ADR-009). Exactly one verdict per run, precedence-ordered:
  // (1) insufficient_evidence  (entity unresolved OR zero outcome='ok' attempts)
  // (2) changed                (comparable + differs; authoritative ∧ fresh; conflicts shown)
  // (3) verified_unchanged     (comparable + equal; authoritative ∧ fresh; no unresolved conflict)
  // (4) no_change_found        (partial base; mandatory reason: stale_source | source_not_authoritative |
  //                              dimension_mismatch | attribute_not_extracted | no_relevant_source | conflicting_unresolved)
}
1. Discover   — query generation from {entity alias set} × {attribute templates}; SearchProvider interface
                (Tavily/Brave/…; fixture-recorded for eval); ranked source list; failures logged on the run
2. Fetch      — HTML→readable text (or vendor JSON API where offered); bodyHash computed; raw snapshot
                referenced by Capture; fetch failures recorded, never fatal, never “no results”
3. Extract    — attribute-specific JSON schema (pricing: [{plan, amount, currency, period, edition}];
                version: {version, releaseDate?}; feature: {plan, available, notes}); schema-validated;
                per-field spans recorded into Evidence
4. Normalize  — unit/currency/period/edition tables; market/edition dims canonicalized; raw kept alongside
5. Store      — Observation upsert keyed by obsKey; superseded chains via SUPERSEDED_BY
6. Compare    — ComparisonOutcome vs historical baseline (§6.3), then Verdict (§6.4)
```

### 6.2 Reusability
One engine; domains are `{attribute vocabulary + extraction schema + normalization table}` plugins: pricing (CRM example), software versions/releases, hosting economics, feature availability. Adding a domain = config + schema, zero new code paths.

### 6.3 ComparisonOutcome (separate from Verdict)
`compare(obsA, obsB) → ComparisonOutcome`:
- `comparable` — every dimension in the comparison key set matches exactly (plan, edition, billingPeriod, currency, region, unit).
- `dimension_mismatch { mismatchedKeys[] }` — e.g. monthly vs annual billing, different edition, different currency without FX evidence. **Comparison refused, reasons returned**; values are shown side-by-side, never differenced.
- `normalization_mismatch { normVersionA, normVersionB }` — cross-obsNormVersion comparisons go through this, never silently.
`COMPARABLE_TO` is at best a TTL’d cache of this computation, invalidated on obsNormVersion or normalization-table bump; never authoritative, never read for truth.

### 6.4 Verdict (what research established — exactly four)
| verdict | meaning | precedence & evidence (from per-attempt `attempts[]`) |
|---|---|---|
| `insufficient_evidence` | evidence base cannot be established at all | rung 1: entity unresolvable, or **zero** `outcome='ok'` attempts. Failing attempts listed verbatim. |
| `changed` | comparable, values differ | rung 2: current observation, `comparable`, `authoritative ∧ fresh`; conflicts rendered both-side, never averaged |
| `verified_unchanged` | comparable, equal values | rung 3: same gates as `changed`, no unresolved conflict. Stale page ⇒ falls through to rung 4 |
| `no_change_found` | partial base, current comparable value unestablishable | rung 4: mandatory `reason` — `stale_source` / `source_not_authoritative` / `dimension_mismatch` / `attribute_not_extracted` / `no_relevant_source` / `conflicting_unresolved` |

Exactly one verdict per run: first matching rung. `dimension_mismatch` remains a ComparisonOutcome, never evidence of change or stasis. Absence of results never proves absence of change (ADR-009). Freshness derives from source-declared dates, never fetch time.

## 7. Entity resolution (candidate generation ≠ authorization)

1. **Candidate generation (recall-oriented, over-inclusive):** alias exact match; normalized-name trigram overlap; embedding NN cos ≥ 0.85; same type bucket; co-mention blocking.
2. **Decision ladder — similarity never authorizes:**
   - Alias-exact match under same type → direct link (reversible via alias edit). Not a merge.
   - **Strong identity evidence + prior explicit confirmation** (stored `MergePolicy` from a human `same entity` action, or identical external id) → auto-merge allowed. Without prior confirmation, even strong evidence lands in the review queue.
   - Everything else → `resolution_review` queue job; candidates shown side-by-side; no merge. Statement still persists against the best candidate, marked `resolutionStatus: contested` or attached to `:UnresolvedEntity` (flagged, exclusion from entity pages, never dropped).
3. **Explicit merge authorization:** `POST /entities/merge` (or UI action) → `MERGED_INTO` edge + `:MergeEvent` node + optional `MergePolicy` for future auto-link. The *only* merge path besides remembered human confirmation.
4. **Reversible split:** `POST /entities/split` with an **explicit reassignment plan** (`statementIds`, `evidenceIds`, `aliases` per target entity) → new entity, moves exactly the mapped items, `:SplitEvent` recorded, `status='split'` on retired side. Items not in the plan stay flagged for review — **never heuristically assigned**; correct placement cannot be inferred from “the merge was wrong”.
5. **Audit:** merge/split events are first-class and replayable; eval asserts on them. Over-merging is treated as worse than duplicates: it poisons edges; duplicates are recoverable.

**Acceptance invariants:** cos 0.97 with no corroboration → review queue, zero `MERGED_INTO` edges; prior user-confirmed pair → auto-link; wrong merge undone → exactly the planned mapping reassigned (explicit expected mapping in tests), audit chain intact, aliases owned per plan.

## 8. Execution model, consistency, and failure handling

**Job ledger in Neo4j** (`:Job`) — no broker.

**Constraints:** `job.id` unique; `job.idempotencyKey` unique (`CREATE CONSTRAINT job_idem … REQUIRE j.idempotencyKey IS UNIQUE`); index on `(status, nextRunAt)`.

**States:** `pending → running → completed | dead`; lease-expired `running` returns to `pending` via the sweeper. Fields: `workerId`, `leaseUntil`, `attempts`, `maxAttempts`, `claimGeneration` (monotonic fencing token), `lastError`, `payloadJson`.

**Fenced claim protocol** (full spec in ADR-010): per claim, in one write transaction — (1) read one candidate; (2) acquire a **write lock on that node**; (3) **re-check eligibility after lock acquisition** (else start over); (4) claim + `claimGeneration` fencing token, commit atomically. **Ownership is serialized through the node write lock, not revoked at a wall-clock instant** (ADR-010): `leaseUntil > now()` and `claimGeneration` are re-validated at fence time, inside the transaction holding the lock — a transaction that passed its fence owns the operation until COMMIT, even if the lease lapses mid-transaction; the sweeper queues behind the lock and re-validates afterwards. Expiry makes a job *eligible* for reclaim; it never interposes on an in-flight fenced transaction. Fenced completion checks both generation and lease at fence time. **All durable job outputs commit only inside the same transaction that re-validates `status='running' AND claimGeneration=$gen AND leaseUntil > datetime()`** — outputs carry `(jobId, claimGeneration)`; a stale worker’s write transaction aborts and commits nothing. Effects that cannot share the store transaction use **generation-scoped provisional output + fenced promotion** (invisible until promoted; reaped on fence failure). Idempotency keys supplement fencing; they do not replace it. CI integration tests race N claimers against the pinned Neo4j version, including stale output writes and provisional invisibility (ADR-010).

**Lease & stale recovery:** workers heartbeat `leaseUntil`; a sweeper returns expired `running` jobs to `pending` (generation preserved; re-claim bumps it). Completion is idempotent by output keys; handlers are re-runnable. Episode + outbox Job are created in one transaction (no torn writes); the replay scanner is a reconciliation tool for legacy/partial data, never the crash-recovery path.

**Episode + outbox atomicity:** `Episode` and its initial `extract` `:Job` (+ `PENDING_EXTRACTION` edge) are created in **one transaction**. Crash before commit ⇒ neither exists; after ⇒ both. No two-write window exists. The replay scanner (`npm run memory:replay`) is a **reconciliation** tool for legacy imports, manual fixes, and `dead`-job resets — never the recovery path for torn writes.

**Retries:** exponential backoff, `maxAttempts=5` → `dead`, surfaced in `GET /jobs/dead` + UI banner. Raw episodes are always readable regardless of downstream state. **Read-after-write:** FT and graph legs are synchronous with commit (Neo4j full-text updates in-transaction; integration tests pin this, CI asserts `dbms.index.fulltext.eventually_consistent=false`). Vector leg lags and is excluded when `embeddingModel IS NULL`; `consistency=strong` reads skip it entirely. **No arbitrary delays anywhere.**

**Rebuildable derived data:** `npm run rebuild:indexes` drops and recreates vector + FT indexes and re-embeds in batches (job-tracked, resumable, idempotent on content hash + model). This is the migration path for embedding-model upgrades and the corruption recovery path. `npm run memory:check` validates referential + temporal invariants (every Statement ≥1 Evidence; no `validTo < validFrom`; no orphan MERGED_INTO targets).

**Visible partial failures:** `extraction_failed`, `embedding_pending`, `merge_contested`, `resolution_review` are queryable states with counts; the UI surfaces them. Nothing degrades silently.

## 9. Observation identity canonicalization (`obs-norm/1` — pinned)

- **URL:** lowercase scheme+host; default ports stripped; fragment dropped; `utm_*`/`gclid`/`fbclid` dropped; remaining params percent-normalized (unreserved decoded, rest uppercased hex) and sorted by key,value; trailing `/` removed (except root); path case preserved; IDN→A-label. Redirect final URLs recorded on Capture, not identity.
- **Dimensions:** keys sorted/NFC/trimmed/lowercased; values per attribute schema (currency→ISO 4217; billingPeriod∈enum; edition∈enum; region→ISO 3166 α2; unknown values → `unmapped:<raw>` participating in the hash as-is — never dropped).
- **Nullable timestamps:** absent `sourceEffectiveAt`/`sourcePublishedAt` hash as empty field — never as capture time. A later-discovered publication date ⇒ new obsKey ⇒ **new Observation** (it is new information), never a mutation.
- **Values:** numbers→minor-unit integers + ISO currency; dates→ISO-8601 UTC; strings→NFC, trimmed, whitespace-collapsed, with a case-folded comparison twin; booleans/enums per schema; structures→canonical JSON (sorted keys, no spurious whitespace).
- **Hashes:** `valueHash`, `dimHash`, `obsKey` (§3.5) — all `sha256` over canonical serializations.
- **`obsNormVersion`** stored on every Observation; bump ⇒ new obsKeys, cross-version comparison → `normalization_mismatch`, caches invalidated. Never silent.

## 10. Deployment

- **Dev:** `docker compose up` (neo4j:5.x community + APOC pinned; APOC required) → `npm run dev` waits on healthcheck. Node 20 pinned. `.env.example` documents LLM/embedding/search keys; provider fakes let `npm test` and the eval suite run fully offline.
- **Public eval deployment:** single container + Neo4j Aura free tier (or compose on a VM); README cold-start protocol documented; latency measured with cold/warm separation; Aura free-tier limits disclosed alongside any published numbers.
- **Config:** `obs-norm`, embedding model id, Neo4j/APOC versions all pinned and recorded in eval output.
- **Secrets:** never committed; search/LLM keys via env only.
- **Backup:** documented dump/restore (`neo4j-admin database dump`) + replay-from-episodes verified recovery.
- **Consistency setting pinned:** `dbms.index.fulltext.eventually_consistent=false` asserted in CI.

## 11. Implementation sequence — 11 vertical slices, complete scope

Evaluation harness and fixture registry are introduced in **Slice 2** and extended in every later slice; Slice 10 is comprehensive evaluation only (ADR-012). Each slice lists components / contracts / dependencies / acceptance tests / usable-at-completion.

**Slice 1 — Skeleton & memory spine.** **Status: shipped & verified.** Components: compose file, Neo4j migrations+constraints (incl. job constraints), monolith scaffold, EpisodeStore, JobLedger (fenced claim / fenced output commit / fenced completion / provisional promotion / sweep), outbox ingestion, date-scoped raw recall endpoint, `memory:replay` reconciler. Contracts: `Episode`, `Job`, `RecallResult`. Dep: Neo4j only. Accept: clean-clone `docker compose up && npm run dev` green; episode roundtrip; **Example C-step-1 works verbatim**; crash tests yield both-or-nothing; **claim-race integration tests against the pinned Neo4j version green (N competing claimers → one winner; stale-generation completion rejected; stale output writes commit zero nodes; superseded-generation provisional outputs never visible)**; FT read immediately after write passes. Usable: verbatim recall + raw capture.

**Slice 2 — Contracts, fakes & eval scaffold.** **Status: shipped & verified.** Components: zod schemas (Episode/Statement/Entity/Observation/Evidence/Capture), provider interfaces + in-memory fakes, clock/id injection, error taxonomy, telemetry counters, `eval/` runner + matcher DSL + fixture registry + deterministic mode. Contracts: all data contracts (code twins). Accept: offline `npm test`; runner fails on regression (negative control); fixture-drift hash check; `npm run eval` skeleton exits 0. Usable: nothing user-facing — everything later is testable offline.

**Slice 3 — Extraction → Statements.** **Status: implemented and offline-verified; real-Neo4j integration run pending explicit approval.** Components shipped: versioned extraction prompt + structured output; grounding validator (exact UTF-16 quote↔span match, subject AND object must appear in the cited span, deliberately small closed predicate vocabulary, temporal/modality/decision-status coherence); deterministic content-addressed statement IDs aligned with every immutable persisted field; exact-duplicate collapse; all-or-nothing per episode with structured validation reasons on the job error; append-only, idempotent `StatementStore` with immutable-content conflict detection; offline ledger/store transaction with staging and rollback so a failed later insert leaves zero statements, evidence, or entities; extraction eval SUT with 22 extraction golden cases. Contracts: `CandidateStatement`, `ExtractResult`, `StatementWrite`. The provider is injected and remains test/eval-only (deterministic fake) until a real LLM adapter exists — no fake in the production path. Accept (offline): `npx tsc --noEmit`, `npm run test:unit`, `npm run eval` green; eval reports 27 executed cases passing with 10 declarative cases for later slices pending, provider basis MOCKED and semantic quality NOT MEASURED. Still open from the original Slice 3 scope: real-provider semantic evaluation, the three challenge transcripts end-to-end, embedding worker, aligning the prompt's predicate guidance with the closed vocabulary, UI failure banner, and the real-Neo4j integration run (`test/integration/extraction.test.ts` is written and type-checked, not executed). Usable: offline semantic capture + episodic→statement pipeline.

**Slice 4 — Entity resolution.** Components: blocking (trigram + embedding NN + type + co-mention), alias linking, review queue, soft merge/split with explicit reassignment plan, `:MergeEvent`/`:SplitEvent`, `MergePolicy` memory. Contracts: `ResolutionDecision`, `MergePlan`, `SplitPlan`. Accept: five CRMs → five entities; alias-exact links without review; cos-0.97-no-corroboration → review queue, no merge; explicit-mapping split reassigns exactly the mapped statements/evidence/aliases; audit history intact. Usable: entity pages + decision recall grounding.

**Slice 5 — Temporal core & corrections.** Components: `TemporalFilter` (single implementation, both axes), `CorrectionService` (append-only `:LifecycleEvent` + `SUPERSEDES` edges; `status` projection rebuilt and validated — never content mutation), conflict detection (`CONFLICTS_WITH`), tz/precision-safe day bounds, “interpreted as …” echo contract. Contracts: `AsOf`, `CorrectionResult`. Accept: as-of before/after price-change fixtures; transactions-time filter “what did we believe on 3 Nov”; conflict fixture surfaces both claims; day-boundary tz case passes; property tests on interval logic. Usable: full temporal reasoning + user corrections.

**Slice 6 — Hybrid retrieval & synthesis.** Components: Retriever (three legs + RRF + hop budgets + as-of injection), EvidenceResolver, Synthesizer (citations + certainty language + verbatim quotes), deterministic router (Q1/Q4), `consistency=strong` mode. Contracts: `EvidenceBundle`, `ScoredCandidate`, `GroundedAnswer`. Accept: golden semantic queries recall@5 target met; citation precision 100% on fixtures (quote ⊂ source); p95 <1.5s warm; strong-consistency-after-write case passes. Usable: **Example B**, general cited Q&A.

**Slice 7 — Research subsystem.** Components: SearchProvider (+fixtures), fetch/readability, attribute schemas (pricing, version, hosting.cost, feature), normalization tables + `obs-norm/1` pin, Observation store, Capture records, ComparisonOutcome engine, four-verdict computation, `:ResearchRun` coverage accounting. Contracts: `Observation`, `Capture`, `ResearchRun`, `ComparisonOutcome`, `Verdict`. Accept: full verdict-matrix fixtures; re-fetch identical → 2 Captures/1 Observation; price change → new Observation + SUPERSEDED_BY; monthly-vs-annual → `dimension_mismatch{billingPeriod}` never compared; empty search → `insufficient_evidence`; redesigned page → `no_change_found`; conflicting sources both retained. Usable: **Example C-step-2, Example B verification**, pricing & release tracking.

**Slice 8 — Reasoning flows.** Components: orchestrators `recall`, `verifyAnswer` (recall→volatile-claim extraction→research→diff), `changeDetection`, `entityRecall`, `semantic`; validated planner-LLM (enums, clamped hops, 2 retries → Q5 default); verification advisory wiring. Contracts: flow I/O types; `VerificationReport`. Accept: **all three challenge examples end-to-end**; false-“no change” trap = 0 tolerance; planner fallback tested; Q3 with `no_baseline` reports unknown. Usable: complete challenge functionality.

**Slice 9 — Change monitoring & comparison UX.** Components: `research:refresh` recency-aware jobs, observation history queries, “changed since <date>” digest, mismatch reporting surface. Contracts: `ChangeDigest`. Accept: refresh job creates observations only on delta; cross-norm-version comparison → `normalization_mismatch`; digest shows both periods with captures. Usable: passive monitoring beyond point queries.

**Slice 10 — Comprehensive evaluation.** Components: full golden set (~35 cases JSONL, disjoint holdout), baseline matrix (vector-only / graph-only / hybrid), metrics (recall@k, MRR, citation precision, verdict accuracy, false-no-change safety, p50/p95, tokens), regression thresholds in CI, `docs/eval-results.md`, reproducibility protocol. Accept: hybrid ≥ each single leg per the agreed comparison or the simpler leg ships and the report says so; holdout run reported; deterministic replay passes. Usable: defensible, reproducible submission evidence.

**Slice 11 — Ops & hardening.** Components: `rebuild:indexes` (drop/refill/batched re-embed), `memory:check` invariant validator, dead-letter UI + banner, tombstone deletion (GDPR-style), cost budgets + kill switch, backup/restore doc, container + Aura deployment, README (architecture, runbook, ADRs index). Accept: rebuild from scratch restores retrieval; reset→replay reproduces graph modulo ids; cold public deploy <10 min; kill switch halts LLM spend. Usable: release candidate.

Slices 1–8 are the critical path (complete challenge functionality + verification). 9–11 harden and prove. No throwaway code anywhere; every slice lands tests and golden cases.

## 12. Explicit deferrals (with reasons)
Query-plan cache (premature; RRF + router already fast, measure first) · reranker (added only if Slice 10 shows RRF failing on entity-heavy cases) · consolidation/decay worker (not exercised by requirements; designed elsewhere) · external knowledge graph (search+citation verification suffices; adds failure surface) · agent/multi-agent orchestration (nondeterminism breaks eval reproducibility) · separate vector DB (ADR-002) · learned fusion (no training data) · multi-tenant auth · streaming APIs · mobile/voice. None of these is required for complete functionality.

## 13. Risks (honest, unresolved)
1. Extraction quality on messy dialogue — mitigated by validation, never eliminated; eval quantifies.
2. `verified_unchanged` trustworthiness inherits search/fetch quality; single-source pricing claims should trend to `no_change_found` on disagreement, not silent pass.
3. Embedding deprecation → forced re-embed; mitigated by `embeddingModel` tagging + `rebuild:indexes`; not eliminated.
4. Natural-date parsing errors (“Monday”) → wrong as-of filter → confident wrong answer; mitigated by mandatory “interpreted as …” echo.
5. Neo4j community memory under vector + alias-heavy loads; sized & documented, not load-tested.
6. Golden-set overfitting — mitigated by holdout in Slice 10.
7. Aura free-tier cold start distorts public latency numbers; protocol disclosed in docs.
8. `obs-norm` canonicalization bugs can silently fork identity (duplicate observations) — fuzz tests mandatory in Slice 7.

## 14. Self-critique
- Reified Statements cost ~2× node count; justified by modality/polarity/correction semantics that property edges cannot carry (ADR-003).
- 11 slices is a lot of documents-in-flight; mitigated by each slice being independently shippable and sequential-only dependencies.
- Observation/Statement boundary adds a second fact type; the alternative (overloaded Statement) loses dimension-aware comparison and immutability guarantees — kept, deliberately.
- The fragile core is Q2/Q3 quality, gated entirely on research quality; if source coverage proves poor on eval fixtures, the honest response is to downgrade those answers to `insufficient_evidence`, which the architecture supports *by construction* — that is its main safety property.
- If forced to simplify under deadline: Slice 9 refresh jobs and Slice 11 extras (tombstoning, kill switch) degrade to documented stubs first; nothing else does.

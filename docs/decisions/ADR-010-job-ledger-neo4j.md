# ADR-010: Job ledger in Neo4j; fenced, transaction-claimed jobs; Episode+Job written atomically

**Status:** Accepted (supersedes earlier claim-protocol description)

## Context
Ingestion, embeddings, research refreshes, and index rebuilds must survive crashes without losing raw conversation data, without double-execution, and without a broker. The naive claim pattern (`MATCH … WHERE status='pending' … SET status='running'` in one transaction) is **not** a safe single-winner guarantee under Neo4j's default read-committed isolation: two transactions can both read the same pending candidate before either writes; the loser may silently update a row the winner already claimed. This ADR defines the actual protocol.

## Decision

A `:Job` node in Neo4j is the ledger; atomicity is established by lock acquisition + revalidation + a fencing token, committed in one transaction:

**Constraints:** `job.id` unique; `job.idempotencyKey` unique; index on `(status, nextRunAt)`.

**States:** `pending → running → completed | dead`; lease-expired `running` returns to `pending` via the sweeper. Fields: `workerId`, `leaseUntil`, `attempts`, `claimGeneration` (integer, monotonically increasing — **the fencing token**), `lastError`, `payloadJson`.

**Claim protocol (one write transaction):**
1. **Candidate selection:** read one candidate `MATCH (j:Job) WHERE j.status='pending' AND j.nextRunAt <= datetime() RETURN j.id LIMIT 1`.
2. **Acquire a write lock on the specific node:** `MATCH (j:Job {id: $id}) SET j._lock = $workerId` — the write sets a lock on the node inside this transaction; competing claimers of the same node serialize on it. (Node-level write locking is the only lock Neo4j guarantees; we use it deliberately and document it. `apoc` locking is not required.)
3. **Re-check eligibility after lock acquisition:** `MATCH (j:Job {id: $id}) WHERE j.status='pending' AND j.nextRunAt <= datetime()` — if the node changed hands while we waited, this returns zero rows and we retry from step 1. **This re-check, after the lock, is the correctness hinge.**
4. **Claim and commit atomically:** in the same transaction as steps 2–3, `SET j.status='running', j.workerId=$workerId, j.leaseUntil=datetime()+duration(…), j.attempts=j.attempts+1, j.claimGeneration=coalesce(j.claimGeneration,0)+1, j._lock=null REMOVE j._lock RETURN j`.

**Fenced completion (fencing-token check, not workerId alone):**
```cypher
MATCH (j:Job {id: $id}) WHERE j.status='running' AND j.claimGeneration = $gen
SET j.status='completed', j.completedAt=datetime()
```
A worker that lost its lease, was reclaimed, and finishes late holds an old `claimGeneration`; its completion matches zero rows and is discarded — even if `workerId` was reused, the generation is not. All handler outputs carry the job id + generation and are written idempotently, so discarded late work is harmless re-execution, never corruption.

**Stale-job recovery:** sweeper returns `running` jobs with `leaseUntil < now()` to `pending` (generation preserved — the re-claim increments it, invalidating any late original worker).

**Idempotent enqueue:** `MERGE … ON CREATE SET …` on `idempotencyKey` (unique constraint); duplicates return the existing job.

**Episode + outbox atomicity:** the `Episode` and its initial `extract` `:Job` (+ `PENDING_EXTRACTION` edge) are created in **one transaction**. No torn two-write window exists. The replay scanner is a **reconciliation** tool for legacy/partial/hand-repaired data — not the crash-recovery path.

**Integration testing requirement (not optional):** an integration test suite runs N competing claim transactions against the **pinned Neo4j version** (docker compose service used by CI), asserting: exactly one winner per job across races; loser retries and claims nothing already running; a crashed-and-reclaimed job completed by the original worker is rejected via generation mismatch; a late completion by a stale worker is rejected even when workerId is recycled; sweeper resurrects expired jobs with a bumped generation. Unit tests of the claim function are necessary but never sufficient.

**Retries:** backoff, `maxAttempts=5` → `dead`, visible via `GET /jobs/dead` + UI banner.

## Rejected alternatives
- **Naive single-transaction MATCH+SET claim:** read-committed allows double-claim; rejected (the defect this ADR fixes).
- **workerId-only completion check:** fails when a reclaimed job's late writer shares or reuses identity, or when lease expiry + immediate reclaim occurs before completion; rejected in favor of fencing tokens.
- **APOC-based advisory locking:** introduces an optional-dependency failure surface without adding a guarantee the lock+recheck+commit pattern already provides; rejected (APOC remains for other uses only).
- **Redis/BullMQ, SQLite outbox, fire-and-forget:** as before — rejected (second store / silent loss).
- **Replay scanner as primary recovery:** rejected; it is reconciliation only.

## Consequences
- Claim is two statements in one transaction — marginally more code than the naive version, the price of an explicit guarantee.
- `claimGeneration` must be stored, indexed not required, and propagated to every handler's completion call; missed propagation = silent fence bypass, so it is enforced by the job runner abstraction, not per-handler discipline.
- The pinned Neo4j version + CI integration gate make the concurrency contract a build-enforced property, not documentation.

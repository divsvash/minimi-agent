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

**Lease semantics — serialized ownership, not wall-clock revocation.** `leaseUntil > datetime()` is a conjunctive condition for **all** ownership operations, alongside `claimGeneration`, and is evaluated **at fence time — inside the transaction that holds the job's write lock**. It is not a wall-clock instant at which ownership evaporates:

- A transaction that acquires the job's write lock, passes the fence, and then commits **still owns the operation through COMMIT** — even if `leaseUntil` passes while the transaction is open. The fence check happened inside the lock; the lock is held until the writes are durable; a reclaimer cannot interpose.
- A worker whose lease has expired **at fence time** (i.e. its transaction starts — or its fence check runs — after the lease lapsed) owns nothing: the fence matches zero rows and its outputs/completion are discarded.
- Expiry makes a job *eligible* for reclaim; it does not revoke an in-flight fenced transaction. The ownership transition (fenced holder commits → sweeper requeues → next claim bumps `claimGeneration`) is serialized through the same node write lock, so a fenced transaction and a reclaimer can never both commit.

There is no grace period and no dependence on the sweeper for correctness (the sweeper only requeues; the fences do the rejecting — at fence time, under the lock). Wall-clock revocation mid-transaction was considered and rejected: Neo4j cannot make "ownership must be valid at commit time" true without either holding a lock across the commit boundary (which is exactly the serialized model) or aborting the writer from outside (which the store does not support) — the serialized model is the strongest guarantee available, and this ADR documents it as such rather than implying immediate revocation.

**Fenced output writes (the completion check alone is insufficient):**
**Every durable job output — statements, observations, evidence, child jobs, any side effect persisted to the store — must be committed only in the same transaction that re-validates `status='running' AND claimGeneration=$gen AND leaseUntil > datetime()` at fence time.** Outputs carry `(jobId, claimGeneration)`; the fence check and the output commit happen atomically. A stale worker's output transaction fails the re-validation and commits nothing.

For multi-step or externally-visible effects that cannot share the store transaction (downstream APIs, long fetch loops), use the **provisional pattern**: write generation-scoped provisional output (invisible — either `(:Provisional {jobId, claimGeneration})`-tagged or filtered by a `provisional` flag from all queries and downstream jobs), then **promote** it in the fenced completion transaction. If promotion's fence fails, the provisionals are garbage-collected as invisible debris — they were never readable, never actioned.

Idempotency keys on outputs are **necessary but not sufficient**: they prevent duplicates, not obsolete writes. Both mechanisms coexist — idempotency absorbs retries, fencing rejects staleness.

**Fenced completion (fencing-token check, not workerId alone):**
```cypher
MATCH (j:Job {id: $id}) WHERE j.status='running' AND j.claimGeneration = $gen AND j.leaseUntil > datetime()
SET j.status='completed', j.completedAt=datetime()
```
A late or lease-expired-at-fence-time worker's completion matches zero rows and is discarded — even with a recycled `workerId`, its generation is stale. (A worker whose lease lapses *after* its fence passed, inside the open transaction, completes successfully — the lock serializes it ahead of any reclaimer.) All handlers are idempotent by output keys, so any rejected attempt is harmless re-execution, never corruption.

**Stale-job recovery:** sweeper requeues expired `running` jobs (`leaseUntil < now()` → `pending`); generation preserved at requeue, bumped on the next claim — invalidating any late original worker for both completion and output writes.

**Idempotent enqueue:** `MERGE … ON CREATE SET …` on `idempotencyKey` (unique constraint); duplicates return the existing job.

**Episode + outbox atomicity:** the `Episode` and its initial `extract` `:Job` (+ `PENDING_EXTRACTION` edge) are created in **one transaction**. No torn two-write window exists. The replay scanner is a **reconciliation** tool for legacy/partial/hand-repaired data — not the crash-recovery path.

**Integration testing requirement (not optional):** an integration test suite runs N competing transactions against the **pinned Neo4j version** (docker compose service used by CI), asserting: exactly one winner per job across races; loser re-check yields zero rows and claims nothing already running; a crashed-and-reclaimed job completed by the original worker is rejected via generation mismatch; a late completion by a stale worker is rejected even when workerId is recycled; **stale output writes rejected** — an expired-lease (or superseded-generation) worker attempting to commit outputs in a transaction racing the reclaim commits zero output nodes; **provisional outputs written by a superseded worker never become visible** (no query, no downstream job sees them; sweeper reaps them); sweeper resurrects expired jobs with a bumped generation; handler re-execution after rejection leaves the store identical to a single clean execution. Unit tests of the claim function are necessary but never sufficient.

**Retries:** backoff, `maxAttempts=5` → `dead`, visible via `GET /jobs/dead` + UI banner.

## Rejected alternatives
- **Naive single-transaction MATCH+SET claim:** read-committed allows double-claim; rejected (the defect this ADR fixes).
- **workerId-only completion check:** fails when a reclaimed job's late writer shares or reuses identity, or when lease expiry + immediate reclaim occurs before completion; rejected in favor of fencing tokens.
- **APOC-based advisory locking:** introduces an optional-dependency failure surface without adding a guarantee the lock+recheck+commit pattern already provides; rejected (APOC remains for other uses only).
- **Redis/BullMQ, SQLite outbox, fire-and-forget:** as before — rejected (second store / silent loss).
- **Replay scanner as primary recovery:** rejected; it is reconciliation only.
- **Idempotency keys alone for output safety:** prevents duplicates, not obsolete writes — a stale worker re-executing would commit stale results under fresh-looking keys; rejected — outputs commit only inside the fence-checking transaction (or provisional + fenced promotion).

## Consequences
- Claim is two statements in one transaction — marginally more code than the naive version, the price of an explicit guarantee.
- `claimGeneration` must be stored and propagated into every handler's **output transactions**, not just completion; missed propagation = silent fence bypass (a stale output commits), so the job runner wraps handlers in the fence-checked commit — per-handler discipline is not trusted.
- The pinned Neo4j version + CI integration gate make the concurrency contract a build-enforced property, not documentation.

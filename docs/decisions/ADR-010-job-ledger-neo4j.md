# ADR-010: Job ledger in Neo4j; transaction-claimed; Episode+Job written atomically

**Status:** Accepted

## Context
Ingestion, embeddings, research refreshes, and index rebuilds must survive process crashes without losing raw conversation data, without double-execution, and without a broker or a second operational store. The pipeline spans potentially minutes (fetch+extract) and runs in-process alongside the API.

## Decision
A `:Job` node in Neo4j is the system of record for background work — no Redis/BullMQ/SQS, no separate worker service, no polling external queues.

- **Transactional claim:** single `MATCH … WHERE status='pending' AND nextRunAt <= datetime() … SET status='running', workerId, leaseUntil, attempts=attempts+1 RETURN j` inside one write transaction. The transaction that flips `status` owns the job; racers re-match and see zero rows (or observe `running`) and move on. Guaranteed-single-winner without advisory locks or `CALL … claim` magic.
- **Lease & stale recovery:** workers heartbeat `leaseUntil` during long jobs; a same-process sweeper every 30s returns expired `running` jobs to `pending`. Attempts preserved; no lost work.
- **Completion discipline:** `complete()` applies only `WHERE workerId=$w AND status='running'`; stale-lease completion is a no-op. All handlers are idempotent by output keys (`extract:<episodeId>`, `embed:<stmtId>:<model>`, `research:<entity>:<attr>:<dimHash>:<window>`), so crash-anywhere always resolves by re-execution, never by loss.
- **Idempotent enqueue:** `idempotencyKey` carries a UNIQUE constraint; enqueue is `MERGE ON CREATE` — duplicates are no-ops returning the existing job id.
- **Episode + outbox atomicity:** the `Episode` **and** its initial `extract` Job (+ `PENDING_EXTRACTION` edge) are created in one transaction. Crash ⇒ both or neither; there is no torn state to recover.
- **Retries:** exponential backoff, `maxAttempts=5` → `dead`, visible via `GET /jobs/dead` and a UI banner; manual re-drive via replay endpoint.
- **Replay scanner is reconciliation, not recovery:** it enqueues extraction for episodes lacking completed jobs — used for legacy imports, manual fixes, and post-incident repair. The normal crash path never relies on it.
- **Derived indexes are rebuildable jobs:** `rebuild:indexes` is itself a batched, idempotent, job-tracked operation.

## Rejected alternatives
- **Redis + BullMQ:** second stateful system to run, secure, and back up; its atomicity doesn't span the graph anyway (still needs the outbox discipline); rejected — adds a moving part while removing an invariant.
- **In-process fire-and-forget promises:** any crash loses pending work silently; raw-data loss is unacceptable (ADR-004/010 principle). Rejected.
- **SQLite outbox:** second store again, same split-consistency argument as ADR-002; rejected.
- **Replay scanner as primary recovery:** would mask torn writes and double-processing bugs; demoted to reconciliation after the Episode+Job atomicity fix (Correction 3 of final review).
- **DB-as-queue folklore dismissal ("don't use your database as a queue"):** valid at high throughput; irrelevant here (tens of jobs/minute) and its assumed fix (broker) costs more invariants than it buys. Lease claiming with sweeper is a correct, boring queue at this scale.

## Consequences
- Workers and API share the database budget; documented connection/heap guidance.
- Job payloads are JSON, schema-validated per `kind`; poison payloads land in `dead` with the error preserved.
- Concurrency is bounded by `LIMIT` in claim and worker count; horizontal scaling = more processes against the same ledger, which the transactional claim supports natively.

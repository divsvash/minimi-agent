import type { Driver, Record as Neo4jRecord, Session } from "neo4j-driver";
import { newSession } from "../interfaces/neo4j.js";
import { FencingError } from "../core/errors.js";
import { ids } from "../core/ids.js";

export type JobStatus = "pending" | "running" | "completed" | "dead";

export interface Job {
  id: string;
  kind: string;
  idempotencyKey: string;
  payloadJson: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  claimGeneration: number;
  workerId: string | null;
  leaseUntil: Date | null;
  nextRunAt: Date | null;
  lastError: string | null;
  createdAt?: Date;
}

export interface EnqueueOptions {
  maxAttempts?: number;
  nextRunAt?: Date;
}

export interface LedgerConfig {
  leaseSeconds: number;
  sweepIntervalMs: number;
}

const DEFAULTS: LedgerConfig = { leaseSeconds: 120, sweepIntervalMs: 30_000 };

function toJob(r: Neo4jRecord): Job {
  const j = r.get("j").properties;
  const asDate = (v: unknown): Date | null =>
    v == null ? null : new Date(String(v));
  return {
    id: j.id,
    kind: j.kind,
    idempotencyKey: j.idempotencyKey,
    payloadJson: j.payloadJson,
    status: j.status,
    attempts: j.attempts,
    maxAttempts: j.maxAttempts,
    claimGeneration: j.claimGeneration ?? 0,
    workerId: j.workerId ?? null,
    leaseUntil: asDate(j.leaseUntil),
    nextRunAt: asDate(j.nextRunAt),
    lastError: j.lastError ?? null,
    createdAt: asDate(j.createdAt) ?? undefined,
  };
}

/**
 * Neo4j-backed job ledger (ADR-010).
 *
 * Claiming (single write transaction, one worker wins):
 *   1. read one pending candidate  2. write-lock the node  3. re-check eligibility
 *   4. claim + claimGeneration++ committed atomically.
 * Completion and ALL durable outputs require status='running' AND claimGeneration AND
 * leaseUntil > now() in the SAME transaction — an expired lease revokes ownership immediately.
 * External/multi-step effects use generation-scoped provisional output + fenced promotion.
 */
export class JobLedger {
  constructor(
    private readonly driver: Driver,
    private readonly cfg: LedgerConfig = DEFAULTS,
  ) {}

  /** Idempotent enqueue (unique idempotencyKey; MERGE ON CREATE). Returns the job id. */
  async enqueue(
    kind: string,
    payload: unknown,
    idempotencyKey: string,
    opts: EnqueueOptions = {},
  ): Promise<string> {
    const session = newSession(this.driver, "WRITE");
    try {
      const { records } = await session.run(
        `MERGE (j:Job {idempotencyKey: $key})
         ON CREATE SET j.id = $id, j.kind = $kind, j.payloadJson = $payload,
                       j.status = 'pending', j.attempts = 0,
                       j.maxAttempts = $maxAttempts, j.claimGeneration = 0,
                       j.nextRunAt = coalesce(datetime($nextRunAt), datetime()),
                       j.createdAt = datetime()
         RETURN j.id AS id`,
        {
          key: idempotencyKey,
          id: ids.uuid(),
          kind,
          payload: JSON.stringify(payload),
          maxAttempts: opts.maxAttempts ?? 5,
          nextRunAt: opts.nextRunAt?.toISOString() ?? null,
        },
      );
      return records[0]!.get("id");
    } finally {
      await session.close();
    }
  }

  /** Claim the next eligible job. Returns null when the queue is empty. */
  async claimNext(workerId: string): Promise<Job | null> {
    const tried = new Set<string>();
    const maxRounds = 16;
    for (let round = 0; round < maxRounds; round++) {
      const session = newSession(this.driver, "WRITE");
      try {
        type ClaimResult =
          | { ok: true; job: Job }
          | { ok: false; candidateId: string }
          | null;
        const result: ClaimResult = await session.executeWrite(async (tx) => {
          const cand = await tx.run(
            `MATCH (j:Job) WHERE j.status = 'pending' AND j.nextRunAt <= datetime()
               AND NOT j.id IN $tried
             RETURN j.id AS id ORDER BY j.nextRunAt ASC LIMIT 1`,
            { tried: [...tried] },
          );
          const candidateId: string | undefined = cand.records[0]?.get("id");
          if (!candidateId) return null; // queue empty for us

          // 2. acquire the write lock on this node
          await tx.run(`MATCH (j:Job {id: $id}) SET j._lock = $workerId`, {
            id: candidateId,
            workerId,
          });

          // 3. re-check eligibility AFTER the lock — the correctness hinge
          const re = await tx.run(
            `MATCH (j:Job {id: $id})
             WHERE j.status = 'pending' AND j.nextRunAt <= datetime()
             RETURN j.id AS id`,
            { id: candidateId },
          );
          if (re.records.length === 0) {
            await tx.run(
              `MATCH (j:Job {id: $id}) REMOVE j._lock`,
              { id: candidateId },
            );
            return { ok: false, candidateId } as const;
          }

          // 4. claim — same transaction, generation fence
          const claimed = await tx.run(
            `MATCH (j:Job {id: $id})
             SET j.status = 'running', j.workerId = $workerId,
                 j.leaseUntil = datetime() + duration({seconds: $leaseSeconds}),
                 j.attempts = j.attempts + 1,
                 j.claimGeneration = coalesce(j.claimGeneration, 0) + 1
             REMOVE j._lock
             RETURN j`,
            { id: candidateId, workerId, leaseSeconds: this.cfg.leaseSeconds },
          );
          return { ok: true, job: toJob(claimed.records[0]!) } as const;
        });

        if (result === null) return null;
        if (result.ok) return result.job;
        tried.add(result.candidateId); // lost the race — try another candidate
      } finally {
        await session.close();
      }
    }
    return null;
  }

  /**
   * Acquire the Job write lock and re-validate ownership INSIDE the same
   * transaction (ADR-010). A concurrent sweeper/reclaimer cannot interpose
   * between our check and our writes: we hold the node's write lock from
   * before the re-check until COMMIT. Throws FencingError on loss.
   */
  private async lockAndFence(
    tx: import("neo4j-driver").ManagedTransaction,
    jobId: string,
    claimGeneration: number,
    workerId: string,
    requireLease = true,
  ): Promise<{ attempts: number; maxAttempts: number }> {
    // 1. write-lock the node — serializes against ALL other writers of this job
    await tx.run(`MATCH (j:Job {id: $id}) SET j._lock = $workerId`, {
      id: jobId,
      workerId,
    });
    // 2. re-check after acquiring the lock — eligibility may have changed
    const fence = await tx.run(
      `MATCH (j:Job {id: $id})
       WHERE j.status = 'running' AND j.claimGeneration = $gen
         ${requireLease ? "AND j.leaseUntil > datetime()" : ""}
       RETURN j.attempts AS attempts, j.maxAttempts AS maxAttempts`,
      { id: jobId, gen: claimGeneration },
    );
    if (fence.records.length === 0) {
      await tx.run(`MATCH (j:Job {id: $id}) REMOVE j._lock`, { id: jobId });
      throw new FencingError();
    }
    return {
      attempts: fence.records[0]!.get("attempts") as number,
      maxAttempts: fence.records[0]!.get("maxAttempts") as number,
    };
  }

  /** Remove the transient lock artifact at the end of a fenced transaction. */
  private async unlock(tx: import("neo4j-driver").ManagedTransaction, jobId: string): Promise<void> {
    await tx.run(`MATCH (j:Job {id: $id}) REMOVE j._lock`, { id: jobId });
  }

  /** Heartbeat: extend the lease while working. Succeeds only for the current owner. */
  async renewLease(jobId: string, claimGeneration: number, workerId: string): Promise<boolean> {
    const session = newSession(this.driver, "WRITE");
    try {
      return await session.executeWrite(async (tx) => {
        try {
          await this.lockAndFence(tx, jobId, claimGeneration, workerId);
        } catch {
          return false;
        }
        await tx.run(
          `MATCH (j:Job {id: $id}) SET j.leaseUntil = datetime() + duration({seconds: $leaseSeconds})`,
          { id: jobId, leaseSeconds: this.cfg.leaseSeconds },
        );
        await this.unlock(tx, jobId);
        return true;
      });
    } finally {
      await session.close();
    }
  }

  /**
   * Commit a durable output inside the same fenced transaction as its validation.
   * `write` receives the open transaction; throwing aborts without side effects.
   * Throws FencingError when the job is no longer owned by this generation/lease.
   */
  async commitFencedOutput<T>(
    jobId: string,
    claimGeneration: number,
    workerId: string,
    write: (tx: import("neo4j-driver").ManagedTransaction) => Promise<T>,
  ): Promise<T> {
    const session = newSession(this.driver, "WRITE");
    try {
      return await session.executeWrite(async (tx) => {
        await this.lockAndFence(tx, jobId, claimGeneration, workerId);
        try {
          return await write(tx);
        } finally {
          await this.unlock(tx, jobId);
        }
      });
    } finally {
      await session.close();
    }
  }

  /**
   * Provisional outputs (invisible until fenced promotion):
   * inside `commitFencedOutput`, the handler creates nodes labeled ONLY `:Provisional`
   * with `_targetLabels: ['SomeLabel']` and props incl. jobId + claimGeneration.
   * They are invisible to any query matching (:SomeLabel). `complete()` promotes them
   * via apoc.create.addLabels in the same fenced transaction — after promotion they match,
   * before it they do not. `sweep()` reaps provisionals whose owning job is no longer
   * running under the same generation.
   */
  /** Fenced completion; promotes provisional outputs of THIS generation. */
  async complete(
    jobId: string,
    claimGeneration: number,
    workerId: string,
  ): Promise<boolean> {
    const session = newSession(this.driver, "WRITE");
    try {
      return await session.executeWrite(async (tx) => {
        try {
          await this.lockAndFence(tx, jobId, claimGeneration, workerId);
        } catch {
          return false; // fence lost — stale or reclaimed worker
        }
        await tx.run(
          `MATCH (j:Job {id: $id})
           SET j.status = 'completed', j.completedAt = datetime()`,
          { id: jobId },
        );
        // promote provisional outputs of this generation — visible only now
        await tx.run(
          `MATCH (p:Provisional {jobId: $id, claimGeneration: $gen})
           WITH p CALL apoc.create.addLabels(p, p._targetLabels) YIELD node
           REMOVE node:Provisional REMOVE node._targetLabels`,
          { id: jobId, gen: claimGeneration },
        );
        await this.unlock(tx, jobId);
        return true;
      });
    } finally {
      await session.close();
    }
  }

  /** Fenced failure: requeue with exponential backoff, or dead-letter at maxAttempts. */
  async fail(
    jobId: string,
    claimGeneration: number,
    workerId: string,
    error: string,
  ): Promise<"requeued" | "dead" | "rejected"> {
    const session = newSession(this.driver, "WRITE");
    try {
      return await session.executeWrite(async (tx) => {
        let fence: { attempts: number; maxAttempts: number };
        try {
          fence = await this.lockAndFence(tx, jobId, claimGeneration, workerId);
        } catch {
          return "rejected";
        }
        const { attempts, maxAttempts } = fence;
        if (attempts >= maxAttempts) {
          await tx.run(
            `MATCH (j:Job {id: $id}) SET j.status='dead', j.lastError=$err, j.workerId=null, j.leaseUntil=null`,
            { id: jobId, err: error.slice(0, 2000) },
          );
          await tx.run(
            `MATCH (p:Provisional {jobId: $id, claimGeneration: $gen}) DETACH DELETE p`,
            { id: jobId, gen: claimGeneration },
          );
          await this.unlock(tx, jobId);
          return "dead";
        }
        const backoffMinutes = Math.min(2 ** attempts, 60);
        await tx.run(
          `MATCH (j:Job {id: $id})
           SET j.status='pending', j.lastError=$err, j.workerId=null, j.leaseUntil=null,
               j.nextRunAt = datetime() + duration({minutes: $backoff})`,
          { id: jobId, err: error.slice(0, 2000), backoff: backoffMinutes },
        );
        await this.unlock(tx, jobId);
        return "requeued";
      });
    } finally {
      await session.close();
    }
  }

  /** Sweeper: requeue expired running jobs (lock+recheck each — a concurrent
   *  re-claim between our read and our write must not be clobbered);
   *  reap invisible provisional debris. */
  async sweep(): Promise<{ requeued: number; provisionalsReaped: number }> {
    const read = newSession(this.driver, "READ");
    let expiredIds: string[] = [];
    try {
      const { records } = await read.run(
        `MATCH (j:Job {status: 'running'}) WHERE j.leaseUntil < datetime() RETURN j.id AS id`,
      );
      expiredIds = records.map((r) => r.get("id") as string);
    } finally {
      await read.close();
    }
    let requeued = 0;
    for (const id of expiredIds) {
      const s = newSession(this.driver, "WRITE");
      try {
        const did = await s.executeWrite(async (tx) => {
          // lock first, then re-check — the reclaimer of record keeps or requeues
          await tx.run(`MATCH (j:Job {id: $id}) SET j._lock = 'sweeper'`, { id });
          const recheck = await tx.run(
            `MATCH (j:Job {id: $id}) WHERE j.status = 'running' AND j.leaseUntil < datetime()
             RETURN 1 AS ok`,
            { id },
          );
          if (recheck.records.length === 0) {
            await tx.run(`MATCH (j:Job {id: $id}) REMOVE j._lock`, { id });
            return false;
          }
          await tx.run(
            `MATCH (j:Job {id: $id})
             SET j.status='pending', j.workerId=null, j.leaseUntil=null,
                 j.nextRunAt=datetime(), j.lastError='lease expired (reclaimed by sweeper)'
             REMOVE j._lock`,
            { id },
          );
          return true;
        });
        if (did) requeued += 1;
      } finally {
        await s.close();
      }
    }
    const s2 = newSession(this.driver, "WRITE");
    let provisionalsReaped = 0;
    try {
      const reaped = await s2.executeWrite((tx) =>
        tx.run(
          `MATCH (p:Provisional)
           WHERE NOT EXISTS {
             MATCH (j:Job {status: 'running', id: p.jobId})
             WHERE j.claimGeneration = p.claimGeneration AND j.leaseUntil > datetime()
           }
           DETACH DELETE p
           RETURN count(p) AS n`,
        ),
      );
      provisionalsReaped = reaped.records[0]?.get("n") ?? 0;
    } finally {
      await s2.close();
    }
    return { requeued, provisionalsReaped };
  }

  async deadJobs(): Promise<Job[]> {
    const session = newSession(this.driver, "READ");
    try {
      const { records } = await session.run(
        `MATCH (j:Job {status: 'dead'}) RETURN j ORDER BY j.createdAt DESC`,
      );
      return records.map(toJob);
    } finally {
      await session.close();
    }
  }

  /** Manual re-drive of a dead job (explicit human/operator action). */
  async redrive(jobId: string): Promise<void> {
    const session = newSession(this.driver, "WRITE");
    try {
      await session.run(
        `MATCH (j:Job {id: $id, status: 'dead'})
         SET j.status='pending', j.attempts=0, j.nextRunAt=datetime(), j.lastError=null`,
        { id: jobId },
      );
    } finally {
      await session.close();
    }
  }
}

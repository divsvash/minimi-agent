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

  /** Heartbeat: extend the lease while working. Succeeds only for the current owner. */
  async renewLease(jobId: string, claimGeneration: number, workerId: string): Promise<boolean> {
    const session = newSession(this.driver, "WRITE");
    try {
      const { summary } = await session.run(
        `MATCH (j:Job {id: $id})
         WHERE j.status='running' AND j.claimGeneration = $gen AND j.leaseUntil > datetime()
         SET j.leaseUntil = datetime() + duration({seconds: $leaseSeconds})`,
        { id: jobId, gen: claimGeneration, leaseSeconds: this.cfg.leaseSeconds },
      );
      return (summary.counters.updates().propertiesSet ?? 0) > 0;
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
        const fence = await tx.run(
          `MATCH (j:Job {id: $id})
           WHERE j.status='running' AND j.claimGeneration = $gen AND j.leaseUntil > datetime()
           RETURN j.id AS id`,
          { id: jobId, gen: claimGeneration },
        );
        if (fence.records.length === 0) throw new FencingError();
        return write(tx);
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
        const fence = await tx.run(
          `MATCH (j:Job {id: $id})
           WHERE j.status='running' AND j.claimGeneration = $gen AND j.leaseUntil > datetime()
           SET j.status = 'completed', j.completedAt = datetime()
           RETURN j.id AS id`,
          { id: jobId, gen: claimGeneration },
        );
        if (fence.records.length === 0) return false;
        // promote provisional outputs of this generation — visible only now
        await tx.run(
          `MATCH (p:Provisional {jobId: $id, claimGeneration: $gen})
           WITH p CALL apoc.create.addLabels(p, p._targetLabels) YIELD node
           REMOVE node:Provisional REMOVE node._targetLabels`,
          { id: jobId, gen: claimGeneration },
        );
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
        const fence = await tx.run(
          `MATCH (j:Job {id: $id})
           WHERE j.status='running' AND j.claimGeneration = $gen AND j.leaseUntil > datetime()
           RETURN j.attempts AS attempts, j.maxAttempts AS maxAttempts`,
          { id: jobId, gen: claimGeneration },
        );
        if (fence.records.length === 0) return "rejected";
        const attempts = fence.records[0]!.get("attempts") as number;
        const maxAttempts = fence.records[0]!.get("maxAttempts") as number;
        if (attempts >= maxAttempts) {
          await tx.run(
            `MATCH (j:Job {id: $id}) SET j.status='dead', j.lastError=$err, j.workerId=null, j.leaseUntil=null`,
            { id: jobId, err: error.slice(0, 2000) },
          );
          // dead jobs never get promoted — reap their provisionals
          await tx.run(
            `MATCH (p:Provisional {jobId: $id, claimGeneration: $gen}) DETACH DELETE p`,
            { id: jobId, gen: claimGeneration },
          );
          return "dead";
        }
        const backoffMinutes = Math.min(2 ** attempts, 60);
        await tx.run(
          `MATCH (j:Job {id: $id})
           SET j.status='pending', j.lastError=$err, j.workerId=null, j.leaseUntil=null,
               j.nextRunAt = datetime() + duration({minutes: $backoff})`,
          { id: jobId, err: error.slice(0, 2000), backoff: backoffMinutes },
        );
        return "requeued";
      });
    } finally {
      await session.close();
    }
  }

  /** Sweeper: requeue expired running jobs; reap invisible provisional debris. */
  async sweep(): Promise<{ requeued: number; provisionalsReaped: number }> {
    const session = newSession(this.driver, "WRITE");
    try {
      return await session.executeWrite(async (tx) => {
        const requeued = await tx.run(
          `MATCH (j:Job {status: 'running'}) WHERE j.leaseUntil < datetime()
           SET j.status='pending', j.workerId=null, j.leaseUntil=null,
               j.nextRunAt=datetime(), j.lastError='lease expired (reclaimed by sweeper)'
           RETURN count(j) AS n`,
        );
        const reaped = await tx.run(
          `MATCH (p:Provisional)
           WHERE NOT EXISTS {
             MATCH (j:Job {status: 'running', id: p.jobId})
             WHERE j.claimGeneration = p.claimGeneration AND j.leaseUntil > datetime()
           }
           DETACH DELETE p
           RETURN count(p) AS n`,
        );
        return {
          requeued: requeued.records[0]?.get("n") ?? 0,
          provisionalsReaped: reaped.records[0]?.get("n") ?? 0,
        };
      });
    } finally {
      await session.close();
    }
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

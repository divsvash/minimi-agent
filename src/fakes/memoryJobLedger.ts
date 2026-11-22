import { FencingError } from "../core/errors.js";
import { ids } from "../core/ids.js";
import type { JobWorkerLedger, WorkerJob } from "../jobs/worker.js";
import { MemoryTransaction } from "./memoryTransaction.js";

export type MemoryJobStatus = "pending" | "running" | "completed" | "dead";

export interface MemoryJob {
  id: string;
  kind: string;
  idempotencyKey: string;
  payloadJson: string;
  status: MemoryJobStatus;
  attempts: number;
  maxAttempts: number;
  claimGeneration: number;
  workerId: string | null;
  leaseUntil: Date | null;
  nextRunAt: Date | null;
  lastError: string | null;
}

export interface MemoryEnqueueOptions {
  maxAttempts?: number;
  nextRunAt?: Date;
}

/**
 * Offline twin of the Neo4j `JobLedger` fence, implementing exactly the
 * semantics `JobWorker` depends on (ADR-010):
 *
 *  - claim is a single-writer bump of `claimGeneration`;
 *  - every durable output re-validates (status='running', generation, worker,
 *    lease) at commit time and throws `FencingError` when any check fails;
 *  - `complete`/`fail` report `false`/`rejected` instead of throwing on a lost
 *    fence, so a stale worker can never mark another owner's job done;
 *  - `fail` dead-letters once `attempts >= maxAttempts`.
 *
 * It has no Neo4j, no timers, and no real concurrency: it exists so the worker's
 * fencing behaviour is testable offline. `failNextFence` scripts an explicit
 * lease/generation loss so "stale output must not commit" is observable.
 */
export class InMemoryJobLedger implements JobWorkerLedger<object> {
  private readonly byId = new Map<string, MemoryJob>();
  /** Insertion order — claim scan is deterministic, not map-iteration order. */
  private readonly order: string[] = [];
  private fenceFailures = 0;
  private readonly leaseMs: number;

  constructor(
    private readonly clock: () => Date = () => new Date(),
    leaseMs = 120_000,
  ) {
    this.leaseMs = leaseMs;
  }

  /** Idempotent by `idempotencyKey`, matching the Neo4j MERGE-on-create contract. */
  enqueue(kind: string, payload: unknown, idempotencyKey: string, opts: MemoryEnqueueOptions = {}): string {
    for (const job of this.byId.values()) {
      if (job.idempotencyKey === idempotencyKey) return job.id;
    }
    const now = this.clock();
    const job: MemoryJob = {
      id: ids.uuid(),
      kind,
      idempotencyKey,
      payloadJson: JSON.stringify(payload),
      status: "pending",
      attempts: 0,
      maxAttempts: opts.maxAttempts ?? 5,
      claimGeneration: 0,
      workerId: null,
      leaseUntil: null,
      // Backdated so a just-enqueued job is immediately claimable (mirrors JobLedger).
      nextRunAt: opts.nextRunAt ?? new Date(now.getTime() - 5_000),
      lastError: null,
    };
    this.byId.set(job.id, job);
    this.order.push(job.id);
    return job.id;
  }

  /** Script the next `n` fenced commits to lose their fence before any write. */
  failNextFence(n = 1): void {
    this.fenceFailures += n;
  }

  job(id: string): MemoryJob | null {
    const job = this.byId.get(id);
    return job ? { ...job } : null;
  }

  jobs(): MemoryJob[] {
    return this.order.map((id) => ({ ...this.byId.get(id)! }));
  }

  private fence(jobId: string, claimGeneration: number, workerId: string): MemoryJob {
    const job = this.byId.get(jobId);
    const now = this.clock();
    const leaseUntil = job?.leaseUntil ?? null;
    const leased = leaseUntil !== null && leaseUntil.getTime() > now.getTime();
    if (!job || job.status !== "running" || job.claimGeneration !== claimGeneration
      || job.workerId !== workerId || !leased) {
      throw new FencingError();
    }
    return job;
  }

  async claimNext(workerId: string): Promise<WorkerJob | null> {
    const now = this.clock();
    for (const id of this.order) {
      const job = this.byId.get(id)!;
      if (job.status !== "pending") continue;
      if (job.nextRunAt && job.nextRunAt.getTime() > now.getTime()) continue;
      job.status = "running";
      job.workerId = workerId;
      job.leaseUntil = new Date(now.getTime() + this.leaseMs);
      job.attempts += 1;
      job.claimGeneration += 1;
      return { id: job.id, kind: job.kind, payloadJson: job.payloadJson, claimGeneration: job.claimGeneration };
    }
    return null;
  }

  async renewLease(jobId: string, claimGeneration: number, workerId: string): Promise<boolean> {
    try {
      const job = this.fence(jobId, claimGeneration, workerId);
      job.leaseUntil = new Date(this.clock().getTime() + this.leaseMs);
      return true;
    } catch (err) {
      if (err instanceof FencingError) return false;
      throw err;
    }
  }

  async commitFencedOutput<T>(
    jobId: string,
    claimGeneration: number,
    workerId: string,
    write: (tx: object) => Promise<T>,
  ): Promise<T> {
    this.fence(jobId, claimGeneration, workerId);
    if (this.fenceFailures > 0) {
      this.fenceFailures -= 1;
      throw new FencingError("scripted fence loss");
    }
    // Same shape as Neo4j's executeWrite: the callback receives a transaction
    // whose writes are staged until commit; any throw rolls them all back.
    const tx = new MemoryTransaction();
    try {
      const result = await write(tx);
      tx.commit();
      return result;
    } catch (err) {
      tx.rollback();
      throw err;
    }
  }

  async complete(jobId: string, claimGeneration: number, workerId: string): Promise<boolean> {
    try {
      const job = this.fence(jobId, claimGeneration, workerId);
      job.status = "completed";
      job.workerId = null;
      job.leaseUntil = null;
      return true;
    } catch (err) {
      if (err instanceof FencingError) return false;
      throw err;
    }
  }

  async fail(
    jobId: string,
    claimGeneration: number,
    workerId: string,
    error: string,
  ): Promise<"requeued" | "dead" | "rejected"> {
    let job: MemoryJob;
    try {
      job = this.fence(jobId, claimGeneration, workerId);
    } catch (err) {
      if (err instanceof FencingError) return "rejected";
      throw err;
    }
    job.lastError = error.slice(0, 2000);
    if (job.attempts >= job.maxAttempts) {
      job.status = "dead";
      job.workerId = null;
      job.leaseUntil = null;
      return "dead";
    }
    const backoffMinutes = Math.min(2 ** job.attempts, 60);
    job.status = "pending";
    job.workerId = null;
    job.leaseUntil = null;
    job.nextRunAt = new Date(this.clock().getTime() + backoffMinutes * 60_000);
    return "requeued";
  }
}

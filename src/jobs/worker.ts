import { performance } from "node:perf_hooks";
import { FencingError } from "../core/errors.js";
import { ids } from "../core/ids.js";
import { noopTelemetry, type Telemetry } from "../core/telemetry.js";

/** The subset of a claimed job a handler needs. */
export interface WorkerJob {
  id: string;
  kind: string;
  payloadJson: string;
  claimGeneration: number;
}

/** Structural subset of JobLedger/JobRepository used by the worker. */
export interface JobWorkerLedger<TX extends object> {
  claimNext(workerId: string): Promise<WorkerJob | null>;
  renewLease(jobId: string, claimGeneration: number, workerId: string): Promise<boolean>;
  commitFencedOutput<T>(jobId: string, claimGeneration: number, workerId: string, write: (tx: TX) => Promise<T>): Promise<T>;
  complete(jobId: string, claimGeneration: number, workerId: string): Promise<boolean>;
  fail(jobId: string, claimGeneration: number, workerId: string, error: string): Promise<"requeued" | "dead" | "rejected">;
}

export interface PreparedJob<TX extends object> {
  commit(tx: TX): Promise<void>;
  summary?: string;
}

/**
 * A handler prepares its output OUTSIDE a transaction (provider calls must not
 * hold a job write lock) and commits it inside the fenced transaction.
 */
export interface JobHandler<TX extends object> {
  readonly kind: string;
  prepare(job: WorkerJob): Promise<PreparedJob<TX>>;
}

export type WorkerOutcome = "idle" | "completed" | "requeued" | "dead" | "stale" | "rejected";

export interface JobWorkerOptions {
  workerId?: string;
  /** 0 disables the heartbeat (tests only). */
  leaseRenewMs?: number;
  idleDelayMs?: number;
  telemetry?: Telemetry;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

const errorText = (err: unknown): string => err instanceof Error ? err.message : String(err);

export class JobWorker<TX extends object> {
  private readonly handlers = new Map<string, JobHandler<TX>>();
  readonly workerId: string;
  private readonly leaseRenewMs: number;
  private readonly idleDelayMs: number;
  private readonly telemetry: Telemetry;

  constructor(
    private readonly ledger: JobWorkerLedger<TX>,
    handlers: readonly JobHandler<TX>[],
    options: JobWorkerOptions = {},
  ) {
    for (const handler of handlers) {
      if (this.handlers.has(handler.kind)) throw new Error(`duplicate job handler for kind '${handler.kind}'`);
      this.handlers.set(handler.kind, handler);
    }
    this.workerId = options.workerId ?? ids.uuid();
    this.leaseRenewMs = options.leaseRenewMs ?? 30_000;
    this.idleDelayMs = options.idleDelayMs ?? 1_000;
    this.telemetry = options.telemetry ?? noopTelemetry;
  }

  /** Claim and process at most one job. */
  async runOnce(): Promise<WorkerOutcome> {
    const job = await this.ledger.claimNext(this.workerId);
    if (!job) return "idle";
    this.telemetry.incr("job.claimed");

    const handler = this.handlers.get(job.kind);
    if (!handler) {
      const outcome = await this.ledger.fail(job.id, job.claimGeneration, this.workerId, `no handler registered for job kind '${job.kind}'`);
      this.telemetry.incr(`job.${outcome}`);
      return outcome;
    }

    let leaseLost = false;
    let renewing = false;
    const heartbeat = this.leaseRenewMs > 0
      ? setInterval(() => {
          if (renewing) return;
          renewing = true;
          this.ledger.renewLease(job.id, job.claimGeneration, this.workerId)
            .then((ok) => { if (!ok) leaseLost = true; })
            .catch(() => { /* the fenced commit is the authority, not the heartbeat */ })
            .finally(() => { renewing = false; });
        }, this.leaseRenewMs)
      : null;
    heartbeat?.unref?.();

    const t0 = performance.now();
    try {
      const prepared = await handler.prepare(job);
      if (leaseLost) {
        this.telemetry.incr("job.stale");
        return "stale";
      }
      await this.ledger.commitFencedOutput(job.id, job.claimGeneration, this.workerId, (tx) => prepared.commit(tx));
      const completed = await this.ledger.complete(job.id, job.claimGeneration, this.workerId);
      this.telemetry.timing("job.handle.ms", performance.now() - t0);
      if (!completed) {
        // Output committed, but completion lost the fence. Re-running is safe
        // because every output write is idempotent; never report success.
        this.telemetry.incr("job.stale");
        return "stale";
      }
      this.telemetry.incr("job.completed");
      return "completed";
    } catch (err) {
      if (err instanceof FencingError) {
        this.telemetry.incr("job.stale");
        return "stale";
      }
      const outcome = await this.ledger.fail(job.id, job.claimGeneration, this.workerId, errorText(err));
      this.telemetry.timing("job.handle.ms", performance.now() - t0);
      this.telemetry.incr(`job.${outcome}`);
      return outcome;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  /**
   * Bounded cooperative loop. `stop()` aborts the idle wait; an in-flight job is
   * allowed to finish and commit or fail under the normal fence rules.
   */
  async runLoop(signal: AbortSignal, opts: { maxIterations?: number } = {}): Promise<void> {
    let iterations = 0;
    while (!signal.aborted) {
      if (opts.maxIterations !== undefined && iterations >= opts.maxIterations) return;
      iterations += 1;
      const outcome = await this.runOnce();
      if (signal.aborted) return;
      if (outcome === "idle") await sleep(this.idleDelayMs, signal);
    }
  }
}

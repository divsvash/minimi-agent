import type { IdGenerator } from "../core/idGenerator.js";

/**
 * Deterministic id generator for tests and offline evaluation.
 * Produces stable, sortable ids ("id-000001", ...) so fixture output is byte-stable.
 */
export class DeterministicIdGenerator implements IdGenerator {
  private counter: number;
  private readonly prefix: string;
  constructor(opts: { prefix?: string; start?: number } = {}) {
    this.prefix = opts.prefix ?? "id";
    this.counter = opts.start ?? 0;
  }
  uuid(): string {
    this.counter += 1;
    return `${this.prefix}-${String(this.counter).padStart(6, "0")}`;
  }
  get issued(): number {
    return this.counter;
  }
}

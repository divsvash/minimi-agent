/**
 * Minimal offline transaction handle. Mirrors the single write transaction that
 * Neo4j's `session.executeWrite` gives the real store: writes accumulate in a
 * private working copy and become visible only on commit. Any throw before
 * commit discards the whole working copy, so a later failed insert rolls back
 * earlier ones exactly as a real transaction would.
 */
export interface Snapshottable {
  snapshot(): unknown;
  restore(snapshot: unknown): void;
}

export class MemoryTransaction {
  private readonly snapshots = new Map<Snapshottable, unknown>();
  private readonly order: Snapshottable[] = [];
  private finished = false;

  /** Return this transaction's working copy of `resource`, created on first use. */
  workingCopy<T>(resource: Snapshottable): T {
    if (!this.snapshots.has(resource)) {
      this.snapshots.set(resource, resource.snapshot());
      this.order.push(resource);
    }
    return this.snapshots.get(resource) as T;
  }

  commit(): void {
    if (this.finished) throw new Error("transaction is already finished");
    for (const resource of this.order) resource.restore(this.snapshots.get(resource));
    this.finished = true;
  }

  rollback(): void {
    this.snapshots.clear();
    this.order.length = 0;
    this.finished = true;
  }
}

export function isMemoryTransaction(tx: object): tx is MemoryTransaction {
  return tx instanceof MemoryTransaction;
}

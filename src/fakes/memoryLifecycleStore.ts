import type { LifecycleStore } from "../contracts/ports.js";
import type { LifecycleEvent } from "../contracts/schemas.js";
import { isMemoryTransaction, type Snapshottable } from "./memoryTransaction.js";

interface LifecycleState {
  events: Map<string, LifecycleEvent>;
  edges: { kind: string; from: string; to: string }[];
}

/** Offline twin of the append-only LifecycleEvent store, with fence staging. */
export class InMemoryLifecycleStore implements LifecycleStore<object>, Snapshottable {
  private readonly stateValue: LifecycleState = { events: new Map(), edges: [] };

  private state(tx: object): LifecycleState {
    return isMemoryTransaction(tx) ? tx.workingCopy<LifecycleState>(this) : this.stateValue;
  }

  snapshot(): LifecycleState {
    return {
      events: new Map([...this.stateValue.events].map(([id, e]) => [id, structuredClone(e)])),
      edges: this.stateValue.edges.map((e) => ({ ...e })),
    };
  }

  restore(snapshot: unknown): void {
    const next = snapshot as LifecycleState;
    this.stateValue.events.clear();
    for (const [id, event] of next.events) this.stateValue.events.set(id, structuredClone(event));
    this.stateValue.edges.length = 0;
    this.stateValue.edges.push(...next.edges.map((e) => ({ ...e })));
  }

  async events(): Promise<LifecycleEvent[]> {
    return [...this.stateValue.events.values()].map((e) => structuredClone(e));
  }

  async event(id: string): Promise<LifecycleEvent | null> {
    const event = this.stateValue.events.get(id);
    return event ? structuredClone(event) : null;
  }

  async edges(): Promise<{ kind: string; from: string; to: string }[]> {
    return this.stateValue.edges.map((e) => ({ ...e }));
  }

  async putEvent(tx: object, event: LifecycleEvent): Promise<void> {
    const state = this.state(tx);
    if (state.events.has(event.id)) return; // append-only + idempotent
    state.events.set(event.id, structuredClone(event));
    state.edges.push({ kind: "TARGETS", from: event.id, to: event.targetId });
    if (event.kind === "superseded" && event.replacementId) {
      state.edges.push({ kind: "SUPERSEDES", from: event.replacementId, to: event.targetId });
    }
    if (event.kind === "retracted") {
      state.edges.push({ kind: "RETRACTS", from: event.id, to: event.targetId });
    }
    if (event.kind === "conflicted" && event.otherId) {
      state.edges.push({ kind: "CONFLICTS_WITH", from: event.targetId, to: event.otherId });
    }
  }
}

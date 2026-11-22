import { systemClock, type Clock } from "../core/clock.js";
import type {
  Entity, MergeEvent, ResolutionOutcome, SplitEvent,
} from "../contracts/schemas.js";
import type { ResolutionStore } from "../contracts/ports.js";
import { isMemoryTransaction, type Snapshottable } from "./memoryTransaction.js";
import type { InMemoryStatementStore } from "./memoryStatementStore.js";

interface ResolutionState {
  local: Map<string, Entity>;
  overrides: Map<string, Entity>;
  edges: Map<string, string>;
  mergeEvents: Map<string, MergeEvent>;
  splitEvents: Map<string, SplitEvent>;
  outcomes: Map<string, ResolutionOutcome>;
  reassigned: Map<string, { subjectId?: string; objectId?: string }>;
  /** Test/eval-only association seed for entities that have no persisted statements. */
  seeded: Map<string, { statementIds: string[]; evidenceIds: string[] }>;
}

/**
 * Offline twin of the Neo4j resolution store. All mutations participate in the
 * same MemoryTransaction staging/rollback mechanism as the statement store, so
 * a fenced extraction commit cannot leave half-written resolution output.
 */
export class InMemoryResolutionStore implements ResolutionStore<object>, Snapshottable {
  private readonly stateValue: ResolutionState = {
    local: new Map(),
    overrides: new Map(),
    edges: new Map(),
    mergeEvents: new Map(),
    splitEvents: new Map(),
    outcomes: new Map(),
    reassigned: new Map(),
    seeded: new Map(),
  };

  constructor(
    private readonly statements: InMemoryStatementStore,
    private readonly clock: Clock = systemClock,
  ) {}

  private state(tx: object): ResolutionState {
    return isMemoryTransaction(tx) ? tx.workingCopy<ResolutionState>(this) : this.stateValue;
  }

  snapshot(): ResolutionState {
    const copy = <K, V>(map: Map<K, V>): Map<K, V> =>
      new Map([...map].map(([key, value]) => [key, structuredClone(value)] as [K, V]));
    return {
      local: copy(this.stateValue.local),
      overrides: copy(this.stateValue.overrides),
      edges: copy(this.stateValue.edges),
      mergeEvents: copy(this.stateValue.mergeEvents),
      splitEvents: copy(this.stateValue.splitEvents),
      outcomes: copy(this.stateValue.outcomes),
      reassigned: copy(this.stateValue.reassigned),
      seeded: copy(this.stateValue.seeded),
    };
  }

  restore(snapshot: unknown): void {
    const next = snapshot as ResolutionState;
    const replace = <K, V>(target: Map<K, V>, source: Map<K, V>): void => {
      target.clear();
      for (const [key, value] of source) target.set(key, value);
    };
    replace(this.stateValue.local, next.local);
    replace(this.stateValue.overrides, next.overrides);
    replace(this.stateValue.edges, next.edges);
    replace(this.stateValue.mergeEvents, next.mergeEvents);
    replace(this.stateValue.splitEvents, next.splitEvents);
    replace(this.stateValue.outcomes, next.outcomes);
    replace(this.stateValue.reassigned, next.reassigned);
    replace(this.stateValue.seeded, next.seeded);
  }

  async entities(): Promise<Entity[]> {
    const byId = new Map(this.statements.allEntities().map((e) => [e.id, e]));
    for (const [id, entity] of this.stateValue.local) byId.set(id, entity);
    for (const [id, entity] of this.stateValue.overrides) byId.set(id, entity);
    return [...byId.values()].map((e) => structuredClone(e));
  }

  async entityById(id: string): Promise<Entity | null> {
    const override = this.stateValue.overrides.get(id) ?? this.stateValue.local.get(id);
    if (override) return structuredClone(override);
    return (await this.entities()).find((e) => e.id === id) ?? null;
  }

  private effective(statementId: string): { subjectId: string; objectId?: string } | null {
    const s = this.statements.allStatements().find((item) => item.id === statementId);
    if (!s) return null;
    const change = this.stateValue.reassigned.get(statementId);
    return {
      subjectId: change?.subjectId ?? s.subjectId,
      objectId: s.objectKind === "entity" ? (change?.objectId ?? s.objectId) : undefined,
    };
  }

  async statementIdsForEntity(entityId: string): Promise<string[]> {
    const fromStatements = this.statements.allStatements()
      .filter((s) => {
        const effective = this.effective(s.id)!;
        return effective.subjectId === entityId || effective.objectId === entityId;
      })
      .map((s) => s.id);
    const seeded = [...this.stateValue.seeded.entries()]
      .filter(([, links]) => links.statementIds.length > 0)
      .filter(([id]) => id === entityId)
      .flatMap(([, links]) => links.statementIds);
    return [...new Set([...fromStatements, ...seeded])].sort();
  }

  async evidenceIdsForStatements(statementIds: string[]): Promise<string[]> {
    const fromStore = statementIds.flatMap((id) => this.statements.evidenceFor(id).map((e) => e.id));
    const seededLinks = [...this.stateValue.seeded.values()]
      .filter((links) => links.statementIds.some((id) => statementIds.includes(id)))
      .flatMap((links) => links.evidenceIds);
    return [...new Set([...fromStore, ...seededLinks])].sort();
  }

  async mergeEdges(): Promise<{ from: string; to: string }[]> {
    return [...this.stateValue.edges.entries()].map(([from, to]) => ({ from, to }));
  }

  async mergeEvent(id: string): Promise<MergeEvent | null> {
    const event = this.stateValue.mergeEvents.get(id);
    return event ? structuredClone(event) : null;
  }

  async splitEvent(id: string): Promise<SplitEvent | null> {
    const event = this.stateValue.splitEvents.get(id);
    return event ? structuredClone(event) : null;
  }

  async mergeEvents(): Promise<MergeEvent[]> {
    return [...this.stateValue.mergeEvents.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((e) => structuredClone(e));
  }

  async splitEvents(): Promise<SplitEvent[]> {
    return [...this.stateValue.splitEvents.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((e) => structuredClone(e));
  }

  async outcomes(): Promise<ResolutionOutcome[]> {
    return [...this.stateValue.outcomes.values()].map((o) => structuredClone(o));
  }

  /** Test/eval-only: associate synthetic statement/evidence ids with an entity. */
  seedLinks(entityId: string, statementIds: string[], evidenceIds: string[]): void {
    this.stateValue.seeded.set(entityId, { statementIds: [...statementIds], evidenceIds: [...evidenceIds] });
  }

  /** Test/eval-only: script an existing MERGED_INTO edge (cycle/idempotency probes). */
  seedMergeEdge(from: string, to: string): void {
    this.stateValue.edges.set(from, to);
  }

  async putEntity(tx: object, entity: Entity): Promise<Entity> {
    const state = this.state(tx);
    state.local.set(entity.id, structuredClone(entity));
    return structuredClone(entity);
  }

  async addAlias(tx: object, entityId: string, aliases: string[]): Promise<void> {
    if (aliases.length === 0) return;
    const state = this.state(tx);
    const existing = await this.entityById(entityId);
    if (!existing) return;
    const merged = [...new Set([...existing.aliases, ...aliases])];
    if (merged.length === existing.aliases.length) return;
    state.overrides.set(entityId, {
      ...structuredClone(existing),
      aliases: merged,
      updatedAt: this.clock.now().toISOString(),
    });
  }

  async putMerge(tx: object, event: MergeEvent, sourceId: string, target: Entity): Promise<void> {
    const state = this.state(tx);
    state.mergeEvents.set(event.id, structuredClone(event));
    state.edges.set(sourceId, event.targetId);

    const source = await this.entityById(sourceId);
    if (source) {
      state.overrides.set(sourceId, {
        ...structuredClone(source),
        status: "merged",
        updatedAt: event.recordedAt,
      });
    }
    const currentTarget = await this.entityById(event.targetId);
    if (currentTarget) {
      state.overrides.set(event.targetId, {
        ...structuredClone(currentTarget),
        canonicalName: target.canonicalName,
        aliases: [...new Set([...currentTarget.aliases, ...event.aliases])],
        updatedAt: event.recordedAt,
      });
    }
  }

  async putSplit(tx: object, event: SplitEvent, source: Entity, created: Entity): Promise<void> {
    const state = this.state(tx);
    state.splitEvents.set(event.id, structuredClone(event));
    state.local.set(created.id, structuredClone(created));

    if (source) {
      state.overrides.set(source.id, {
        ...structuredClone(source),
        status: "split",
        aliases: source.aliases.filter((alias) => !event.aliases.includes(alias)),
        updatedAt: event.recordedAt,
      });
    }
    for (const statementId of event.statementIds) {
      const effective = this.effective(statementId);
      const change: { subjectId?: string; objectId?: string } = { ...state.reassigned.get(statementId) };
      if (effective?.subjectId === event.sourceId) change.subjectId = created.id;
      if (effective?.objectId === event.sourceId) change.objectId = created.id;
      state.reassigned.set(statementId, change);
    }

    // Synthetic (eval-only) links move with the reassignment so the offline twin
    // answers the same association queries as Neo4j's re-pointed SUBJECT/OBJECT edges.
    const sourceSeed = state.seeded.get(event.sourceId);
    if (sourceSeed) {
      const movedStatements = event.statementIds.filter((id) => sourceSeed.statementIds.includes(id));
      const movedEvidence = event.evidenceIds.filter((id) => sourceSeed.evidenceIds.includes(id));
      const remainingStatements = sourceSeed.statementIds.filter((id) => !movedStatements.includes(id));
      const remainingEvidence = sourceSeed.evidenceIds.filter((id) => !movedEvidence.includes(id));
      if (remainingStatements.length > 0 || remainingEvidence.length > 0) {
        state.seeded.set(event.sourceId, { statementIds: remainingStatements, evidenceIds: remainingEvidence });
      } else {
        state.seeded.delete(event.sourceId);
      }
      if (movedStatements.length > 0 || movedEvidence.length > 0) {
        const targetSeed = state.seeded.get(created.id) ?? { statementIds: [], evidenceIds: [] };
        state.seeded.set(created.id, {
          statementIds: [...new Set([...targetSeed.statementIds, ...movedStatements])],
          evidenceIds: [...new Set([...targetSeed.evidenceIds, ...movedEvidence])],
        });
      }
    }
  }

  async putOutcome(tx: object, outcome: ResolutionOutcome): Promise<void> {
    this.state(tx).outcomes.set(outcome.id, structuredClone(outcome));
  }
}

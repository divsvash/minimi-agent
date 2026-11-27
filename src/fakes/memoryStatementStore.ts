import { ConflictError } from "../core/errors.js";
import type { Entity, Evidence, Statement } from "../contracts/schemas.js";
import type { ActiveAtFilter, LifecycleStore, StatementStore, StatementWrite } from "../contracts/ports.js";
import { validateStatementWrite } from "../memory/validateStatementWrite.js";
import { immutableEntityContent, immutableStatementContent } from "../memory/statementContent.js";
import { statementValidAt } from "../temporal/intervals.js";
import { visibleAt } from "../temporal/projection.js";
import { isMemoryTransaction, type Snapshottable } from "./memoryTransaction.js";

interface StoreState {
  statements: Map<string, Statement>;
  evidence: Map<string, Evidence>;
  entities: Map<string, Entity>;
  evidenceByStatement: Map<string, string[]>;
  /** Mirrors Neo4j's `(s)-[:SUBJECT]->(e)` edge, which resolution may re-point. */
  subjectByStatement: Map<string, string>;
}

/** Offline StatementStore with the same observable semantics as Neo4j. */
export class InMemoryStatementStore implements StatementStore<object>, Snapshottable {
  private readonly statements = new Map<string, Statement>();
  private readonly evidence = new Map<string, Evidence>();
  private readonly entities = new Map<string, Entity>();
  /** Mirrors Neo4j's `(s)-[:SUPPORTED_BY]->(e)` edge so provenance is queryable offline. */
  private readonly evidenceByStatement = new Map<string, string[]>();
  private readonly subjectByStatement = new Map<string, string>();

  constructor(private readonly lifecycle?: LifecycleStore<object>) {}

  /** Live (committed) state, read by every query method. */
  private liveState(): StoreState {
    return {
      statements: this.statements,
      evidence: this.evidence,
      entities: this.entities,
      evidenceByStatement: this.evidenceByStatement,
      subjectByStatement: this.subjectByStatement,
    };
  }

  /** Private copy for a fenced transaction: writes stay invisible until commit. */
  snapshot(): StoreState {
    const copy = <K, V>(map: Map<K, V>): Map<K, V> =>
      new Map([...map].map(([key, value]) => [key, structuredClone(value)] as [K, V]));
    return {
      statements: copy(this.statements),
      evidence: copy(this.evidence),
      entities: copy(this.entities),
      evidenceByStatement: copy(this.evidenceByStatement),
      subjectByStatement: copy(this.subjectByStatement),
    };
  }

  restore(snapshot: unknown): void {
    const state = snapshot as StoreState;
    const replace = <K, V>(target: Map<K, V>, source: Map<K, V>): void => {
      target.clear();
      for (const [key, value] of source) target.set(key, value);
    };
    replace(this.statements, state.statements);
    replace(this.evidence, state.evidence);
    replace(this.entities, state.entities);
    replace(this.evidenceByStatement, state.evidenceByStatement);
    replace(this.subjectByStatement, state.subjectByStatement);
  }

  async byId(id: string): Promise<Statement | null> {
    const s = this.statements.get(id);
    return s ? structuredClone(s) : null;
  }

  /** Transaction-aware read for other stores committing in the same fence. */
  byIdIn(tx: object, id: string): Statement | null {
    const state = isMemoryTransaction(tx) ? tx.workingCopy<StoreState>(this) : this.liveState();
    const s = state.statements.get(id);
    return s ? structuredClone(s) : null;
  }

  async forSubject(subjectId: string): Promise<Statement[]> {
    return this.sortedStatements()
      .filter((s) => this.subjectFor(s.id, s) === subjectId)
      .map((s) => structuredClone(s));
  }

  /** Relationship-based subject id; the immutable `subjectId` property is never edited. */
  private subjectFor(statementId: string, statement: Statement): string {
    return this.subjectByStatement.get(statementId) ?? statement.subjectId;
  }

  /** Inspection hook: the current SUBJECT edges (statement id → entity id). */
  subjectEdges(): ReadonlyMap<string, string> {
    return new Map(this.subjectByStatement);
  }

  /** Used by resolution/split inside the caller's fence to re-point SUBJECT. */
  setSubjectEdgeIn(tx: object, statementId: string, entityId: string): void {
    const state = isMemoryTransaction(tx) ? tx.workingCopy<StoreState>(this) : this.liveState();
    if (state.statements.has(statementId)) state.subjectByStatement.set(statementId, entityId);
  }

  async activeAt(filter: ActiveAtFilter): Promise<Statement[]> {
    const events = this.lifecycle ? await this.lifecycle.events() : [];
    const txCutoff = filter.asOfTx ? filter.asOfTx.getTime() : null;
    return this.sortedStatements()
      .filter((s) => !filter.asOfValid || statementValidAt(s, filter.asOfValid))
      .filter((s) => txCutoff === null || new Date(s.recordedAt).getTime() <= txCutoff)
      .filter((s) => !filter.subjectId || this.subjectFor(s.id, s) === filter.subjectId)
      .filter((s) => !filter.predicate || s.predicate === filter.predicate)
      .filter((s) => !filter.modality || s.modality === filter.modality)
      .filter((s) => visibleAt(s.id, events, filter.asOfTx))
      .map((s) => structuredClone(s));
  }

  async insert(tx: object, write: StatementWrite): Promise<Statement> {
    // Inside a fenced offline transaction, inserts accumulate in a private
    // working copy and become visible only when the ledger commits it. This is
    // the in-memory equivalent of Neo4j's executeWrite: a later failure rolls
    // back every earlier insert in the same transaction.
    const state = isMemoryTransaction(tx) ? tx.workingCopy<StoreState>(this) : this.liveState();

    // Same write validation as Neo4j: a statement without evidence, with
    // mixed-episode evidence, or without its subject/object entity is rejected
    // here too, so the offline store cannot accept what the real one would not.
    const { statement: validated, evidence, entities } = validateStatementWrite(write);
    const incoming: Statement = { ...validated, status: "active" };

    const existing = state.statements.get(incoming.id);
    if (existing) {
      // Same rule as Neo4j's `WHERE s.contentHash = $hash`: recordedAt and the
      // status projection are first-write/mutable metadata, not immutable content.
      if (JSON.stringify(immutableStatementContent(existing)) !== JSON.stringify(immutableStatementContent(incoming))) {
        throw new ConflictError(`statement ${incoming.id} already exists with different immutable content`);
      }
      // Deliberately NOT a return: Neo4j keeps processing a repeated write — it
      // still MERGEs entities/evidence and (re)creates SUPPORTED_BY and ASSERTS
      // relationships. The rest of this method mirrors that for the offline store.
    }

    for (const e of entities) {
      const prior = state.entities.get(e.id);
      if (prior) {
        // createdAt/updatedAt are first-write metadata, like Neo4j's
        // MERGE ... ON CREATE SET; a matching retry keeps the original values.
        if (JSON.stringify(immutableEntityContent(prior)) !== JSON.stringify(immutableEntityContent(e))) {
          throw new ConflictError(`entity ${e.id} already exists with different content`);
        }
        continue;
      }
      state.entities.set(e.id, structuredClone(e));
    }
    for (const e of evidence) {
      const prior = state.evidence.get(e.id);
      if (prior) {
        // Deliberate parity decision: Neo4j's `MERGE (e:Evidence {id: ev.id})
        // ON CREATE SET ...` keeps the first write's properties and does NOT
        // conflict when an id is reused. Evidence ids are content-addressed, so
        // differing content under one id cannot arise from the extraction path;
        // matching the real store keeps offline eval on the same contract.
        continue;
      }
      state.evidence.set(e.id, structuredClone(e));
    }

    // `MERGE (s)-[:SUPPORTED_BY]->(e)` accumulates across repeated writes. Keep
    // first-seen link order and never duplicate a relationship.
    const links = state.evidenceByStatement.get(incoming.id) ?? [];
    for (const e of evidence) {
      if (!links.includes(e.id)) links.push(e.id);
    }
    state.evidenceByStatement.set(incoming.id, links);

    if (!existing) {
      state.statements.set(incoming.id, incoming);
      // First write only: a retry must not reset a SUBJECT edge re-pointed by resolution.
      state.subjectByStatement.set(incoming.id, incoming.subjectId);
    }
    return structuredClone(existing ?? incoming);
  }

  /** Evidence spans that support `statementId`, in the order they were written. */
  evidenceFor(statementId: string): Evidence[] {
    const ids = this.evidenceByStatement.get(statementId) ?? [];
    return ids
      .map((id) => this.evidence.get(id))
      .filter((e): e is Evidence => e !== undefined)
      .map((e) => structuredClone(e));
  }

  /** Entity ids referenced as subject/object by `statementId`. */
  entitiesFor(statementId: string): Entity[] {
    const s = this.statements.get(statementId);
    if (!s) return [];
    const wanted = new Set<string>([s.subjectId]);
    if (s.objectKind === "entity" && s.objectId) wanted.add(s.objectId);
    return [...this.entities.values()]
      .filter((e) => wanted.has(e.id))
      .map((e) => structuredClone(e));
  }

  allStatements(): Statement[] {
    return this.sortedStatements().map((s) => structuredClone(s));
  }

  allEvidence(): Evidence[] {
    return [...this.evidence.values()].map((e) => structuredClone(e));
  }

  allEntities(): Entity[] {
    return [...this.entities.values()].map((e) => structuredClone(e));
  }

  clear(): void {
    this.statements.clear();
    this.evidence.clear();
    this.entities.clear();
    this.evidenceByStatement.clear();
    this.subjectByStatement.clear();
  }

  get size(): number {
    return this.statements.size;
  }

  private sortedStatements(): Statement[] {
    return [...this.statements.values()].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  }
}

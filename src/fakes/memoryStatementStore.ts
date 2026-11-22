import { ConflictError } from "../core/errors.js";
import type { Entity, Evidence, Statement } from "../contracts/schemas.js";
import type { ActiveAtFilter, StatementStore, StatementWrite } from "../contracts/ports.js";
import { validateStatementWrite } from "../memory/validateStatementWrite.js";

/**
 * Offline StatementStore with the same observable append-only/idempotent
 * semantics as Neo4j for Slice 3. It is not a temporal engine: `activeAt`
 * implements only the conservative valid/recorded-time subset used by Slice 3.
 */
export class InMemoryStatementStore implements StatementStore<object> {
  private readonly statements = new Map<string, Statement>();
  private readonly evidence = new Map<string, Evidence>();
  private readonly entities = new Map<string, Entity>();
  /** Mirrors Neo4j's `(s)-[:SUPPORTED_BY]->(e)` edge so provenance is queryable offline. */
  private readonly evidenceByStatement = new Map<string, string[]>();

  async byId(id: string): Promise<Statement | null> {
    const s = this.statements.get(id);
    return s ? structuredClone(s) : null;
  }

  async forSubject(subjectId: string): Promise<Statement[]> {
    return this.sortedStatements().filter((s) => s.subjectId === subjectId).map((s) => structuredClone(s));
  }

  async activeAt(filter: ActiveAtFilter): Promise<Statement[]> {
    return this.sortedStatements()
      .filter((s) => (s.status ?? "active") === "active")
      .filter((s) => {
        if (!filter.asOfValid) return true;
        const t = filter.asOfValid.getTime();
        const from = s.validFrom ? new Date(s.validFrom).getTime() : null;
        const to = s.validTo ? new Date(s.validTo).getTime() : null;
        return (from === null || from <= t) && (to === null || to > t);
      })
      .filter((s) => !filter.asOfTx || new Date(s.recordedAt).getTime() <= filter.asOfTx.getTime())
      .filter((s) => !filter.subjectId || s.subjectId === filter.subjectId)
      .filter((s) => !filter.predicate || s.predicate === filter.predicate)
      .filter((s) => !filter.modality || s.modality === filter.modality)
      .map((s) => structuredClone(s));
  }

  async insert(_tx: object, write: StatementWrite): Promise<Statement> {
    // Same write validation as Neo4j: a statement without evidence, with
    // mixed-episode evidence, or without its subject/object entity is rejected
    // here too, so the offline store cannot accept what the real one would not.
    const { statement: validated, evidence, entities } = validateStatementWrite(write);
    const incoming: Statement = { ...validated, status: "active" };

    const existing = this.statements.get(incoming.id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(incoming)) {
        throw new ConflictError(`statement ${incoming.id} already exists with different immutable content`);
      }
      return structuredClone(existing);
    }
    for (const e of entities) {
      const prior = this.entities.get(e.id);
      if (prior && JSON.stringify(prior) !== JSON.stringify(e)) {
        throw new ConflictError(`entity ${e.id} already exists with different content`);
      }
      this.entities.set(e.id, structuredClone(e));
    }
    for (const e of evidence) {
      const prior = this.evidence.get(e.id);
      if (prior && JSON.stringify(prior) !== JSON.stringify(e)) {
        throw new ConflictError(`evidence ${e.id} already exists with different content`);
      }
      this.evidence.set(e.id, structuredClone(e));
    }
    this.statements.set(incoming.id, incoming);
    this.evidenceByStatement.set(incoming.id, evidence.map((e) => e.id));
    return structuredClone(incoming);
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
  }

  get size(): number {
    return this.statements.size;
  }

  private sortedStatements(): Statement[] {
    return [...this.statements.values()].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  }
}

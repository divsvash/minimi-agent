import { ConflictError, ValidationError } from "../core/errors.js";
import {
  EntitySchema, EvidenceSchema, StatementSchema,
  type Entity, type Evidence, type Statement,
} from "../contracts/schemas.js";
import type { StatementWrite } from "../contracts/ports.js";

/**
 * Contract-level validation shared by EVERY StatementStore implementation
 * (Neo4j and the offline in-memory twin). Keeping it in one place means the
 * offline store cannot quietly accept a write the real store would reject:
 * a statement without evidence, mixed-episode evidence, or a missing
 * subject/object entity is invalid everywhere.
 */
export interface ValidatedStatementWrite {
  statement: Omit<Statement, "status">;
  evidence: Evidence[];
  entities: Entity[];
}

export function validateStatementWrite(write: StatementWrite): ValidatedStatementWrite {
  const statementParsed = StatementSchema.safeParse({ ...write.statement, status: "active" });
  if (!statementParsed.success) {
    throw new ValidationError("invalid statement write", statementParsed.error.issues);
  }
  if (write.evidence.length === 0) {
    throw new ValidationError("a statement write requires at least one evidence span");
  }

  const evidence: Evidence[] = [];
  for (const item of write.evidence) {
    const parsed = EvidenceSchema.safeParse(item);
    if (!parsed.success) throw new ValidationError("invalid evidence write", parsed.error.issues);
    if (parsed.data.kind !== "episode_span" || !parsed.data.episodeId
      || parsed.data.spanStart === undefined || parsed.data.spanEnd === undefined
      || parsed.data.spanEnd <= parsed.data.spanStart || !parsed.data.quote?.trim()) {
      throw new ValidationError("Slice 3 statements require non-empty episode_span evidence");
    }
    evidence.push(parsed.data);
  }
  const episodeId = evidence[0]!.episodeId!;
  if (evidence.some((e) => e.episodeId !== episodeId)) {
    throw new ValidationError("all evidence for one statement must cite the same episode");
  }

  const entities: Entity[] = [];
  const seen = new Map<string, Entity>();
  for (const item of write.entities) {
    const parsed = EntitySchema.safeParse(item);
    if (!parsed.success) throw new ValidationError("invalid entity write", parsed.error.issues);
    const prior = seen.get(parsed.data.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(parsed.data)) {
      throw new ConflictError(`entity ${parsed.data.id} has conflicting content in one write`);
    }
    if (!prior) {
      seen.set(parsed.data.id, parsed.data);
      entities.push(parsed.data);
    }
  }
  if (!seen.has(write.statement.subjectId)) {
    throw new ValidationError("statement write is missing its subject entity");
  }
  if (write.statement.objectKind === "entity" && (!write.statement.objectId || !seen.has(write.statement.objectId))) {
    throw new ValidationError("entity object write is missing its object entity");
  }

  return { statement: statementParsed.data, evidence, entities };
}

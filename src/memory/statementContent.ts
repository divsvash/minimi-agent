import { ids } from "../core/ids.js";
import type { Entity, Statement } from "../contracts/schemas.js";

/**
 * Canonical immutable content of a statement. This is exactly the field set
 * Neo4j persists in `Statement.contentHash`. `recordedAt` is first-write
 * metadata and `status` is a mutable projection, so neither may make an
 * otherwise identical retry look like a conflict. Single source of truth for
 * the real store's hash and the offline store's duplicate detection.
 */
export function immutableStatementContent(statement: Omit<Statement, "status">): unknown[] {
  return [
    statement.subjectId,
    statement.predicate,
    statement.predicateQualifier ?? null,
    statement.objectKind,
    statement.objectId ?? null,
    statement.objectValue ?? null,
    statement.polarity,
    statement.modality,
    statement.assertedBy,
    statement.epistemicStatus,
    statement.confidence,
    statement.extractionModel ?? null,
    statement.extractionPromptHash ?? null,
    statement.validFrom,
    statement.validTo,
    statement.timePrecision,
    statement.validity,
  ];
}

/** The same hash Neo4j stores as `Statement.contentHash` and checks on retries. */
export function statementContentHash(statement: Omit<Statement, "status">): string {
  return ids.sha256(JSON.stringify(immutableStatementContent(statement)));
}

/** Canonical entity content, excluding `createdAt`/`updatedAt` first-write metadata. */
export function immutableEntityContent(entity: Entity): unknown[] {
  return [
    entity.id,
    entity.type,
    entity.canonicalName,
    [...entity.aliases],
    entity.status,
  ];
}

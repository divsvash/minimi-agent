import type { Driver, ManagedTransaction, Record as Neo4jRecord } from "neo4j-driver";
import { newSession } from "../interfaces/neo4j.js";
import { ConflictError, NotFoundError } from "../core/errors.js";
import { ids } from "../core/ids.js";
import type { Statement } from "../contracts/schemas.js";
import type { ActiveAtFilter, StatementStore, StatementWrite } from "../contracts/ports.js";
import { validateStatementWrite } from "./validateStatementWrite.js";

const asIso = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const asRequiredIso = (v: unknown): string => {
  const iso = asIso(v);
  if (!iso) throw new Error(`invalid datetime value: ${String(v)}`);
  return iso;
};

function toStatement(r: Neo4jRecord): Statement {
  const p = r.get("s").properties as Record<string, unknown>;
  let qualifier: Record<string, string> | undefined;
  if (typeof p.predicateQualifierJson === "string" && p.predicateQualifierJson.length > 0) {
    try {
      qualifier = JSON.parse(p.predicateQualifierJson) as Record<string, string>;
    } catch {
      qualifier = undefined;
    }
  }
  return {
    id: String(p.id),
    subjectId: String(p.subjectId),
    predicate: String(p.predicate),
    predicateQualifier: qualifier,
    objectKind: p.objectKind as Statement["objectKind"],
    objectId: p.objectId === undefined ? undefined : String(p.objectId),
    objectValue: p.objectValue as Statement["objectValue"],
    polarity: p.polarity as Statement["polarity"],
    modality: p.modality as Statement["modality"],
    assertedBy: p.assertedBy as Statement["assertedBy"],
    epistemicStatus: p.epistemicStatus as Statement["epistemicStatus"],
    confidence: Number(p.confidence),
    extractionModel: p.extractionModel === undefined ? undefined : String(p.extractionModel),
    extractionPromptHash: p.extractionPromptHash === undefined ? undefined : String(p.extractionPromptHash),
    validFrom: asIso(p.validFrom),
    validTo: asIso(p.validTo),
    timePrecision: p.timePrecision as Statement["timePrecision"],
    validity: p.validity as Statement["validity"],
    recordedAt: asRequiredIso(p.recordedAt),
    status: (p.status as Statement["status"]) ?? "active",
  };
}

function contentHash(statement: Omit<Statement, "status">): string {
  return ids.sha256(JSON.stringify([
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
  ]));
}

export class Neo4jStatementStore implements StatementStore<ManagedTransaction> {
  constructor(private readonly driver: Driver) {}

  async byId(id: string): Promise<Statement | null> {
    const session = newSession(this.driver, "READ");
    try {
      const { records } = await session.run("MATCH (s:Statement {id: $id}) RETURN s", { id });
      return records[0] ? toStatement(records[0]) : null;
    } finally {
      await session.close();
    }
  }

  async forSubject(subjectId: string): Promise<Statement[]> {
    const session = newSession(this.driver, "READ");
    try {
      const { records } = await session.run(
        `MATCH (s:Statement)-[:SUBJECT]->(:Entity {id: $subjectId})
         RETURN s ORDER BY s.recordedAt`,
        { subjectId },
      );
      return records.map(toStatement);
    } finally {
      await session.close();
    }
  }

  /**
   * Slice 3 implements the conservative valid-time/recorded-time subset only.
   * Lifecycle-event-driven transaction time is Slice 5; no caller may infer
   * full bitemporal semantics from this method yet.
   */
  async activeAt(filter: ActiveAtFilter): Promise<Statement[]> {
    const clauses = ["coalesce(s.status, 'active') = 'active'"];
    const params: Record<string, unknown> = {};
    if (filter.asOfValid) {
      clauses.push(
        "(s.validFrom IS NULL OR s.validFrom <= datetime($asOfValid)) AND (s.validTo IS NULL OR s.validTo > datetime($asOfValid))",
      );
      params.asOfValid = filter.asOfValid.toISOString();
    }
    if (filter.asOfTx) {
      clauses.push("s.recordedAt <= datetime($asOfTx)");
      params.asOfTx = filter.asOfTx.toISOString();
    }
    if (filter.subjectId) {
      clauses.push("s.subjectId = $subjectId");
      params.subjectId = filter.subjectId;
    }
    if (filter.predicate) {
      clauses.push("s.predicate = $predicate");
      params.predicate = filter.predicate;
    }
    if (filter.modality) {
      clauses.push("s.modality = $modality");
      params.modality = filter.modality;
    }
    const session = newSession(this.driver, "READ");
    try {
      const { records } = await session.run(
        `MATCH (s:Statement) WHERE ${clauses.join(" AND ")} RETURN s ORDER BY s.recordedAt`,
        params,
      );
      return records.map(toStatement);
    } finally {
      await session.close();
    }
  }

  async insert(tx: ManagedTransaction, write: StatementWrite): Promise<Statement> {
    const { statement, evidence, entities } = validateStatementWrite(write);
    const episodeId = evidence[0]!.episodeId!;

    const episode = await tx.run("MATCH (ep:Episode {id: $episodeId}) RETURN ep.id AS id", { episodeId });
    if (episode.records.length === 0) throw new NotFoundError(`episode ${episodeId} does not exist`);

    if (entities.length > 0) {
      await tx.run(
        `UNWIND $entities AS ent
         MERGE (e:Entity {id: ent.id})
         ON CREATE SET e.type = ent.type, e.canonicalName = ent.canonicalName,
                       e.aliases = ent.aliases, e.status = ent.status,
                       e.createdAt = datetime(ent.createdAt), e.updatedAt = datetime(ent.updatedAt)`,
        { entities },
      );
    }

    const hash = contentHash(statement);
    const created = await tx.run(
      `MERGE (s:Statement {id: $id})
       ON CREATE SET s.subjectId = $subjectId, s.predicate = $predicate,
                     s.predicateQualifierJson = $qualifierJson,
                     s.objectKind = $objectKind, s.objectId = $objectId, s.objectValue = $objectValue,
                     s.polarity = $polarity, s.modality = $modality,
                     s.assertedBy = $assertedBy, s.epistemicStatus = $epistemicStatus,
                     s.confidence = $confidence,
                     s.extractionModel = $extractionModel, s.extractionPromptHash = $extractionPromptHash,
                     s.validFrom = CASE WHEN $validFrom IS NULL THEN null ELSE datetime($validFrom) END,
                     s.validTo = CASE WHEN $validTo IS NULL THEN null ELSE datetime($validTo) END,
                     s.timePrecision = $timePrecision, s.validity = $validity,
                     s.recordedAt = datetime($recordedAt), s.status = 'active',
                     s.contentHash = $contentHash
       WITH s
       WHERE s.contentHash = $contentHash
       RETURN s`,
      {
        id: statement.id,
        subjectId: statement.subjectId,
        predicate: statement.predicate,
        qualifierJson: JSON.stringify(statement.predicateQualifier ?? {}),
        objectKind: statement.objectKind,
        objectId: statement.objectId ?? null,
        objectValue: statement.objectValue ?? null,
        polarity: statement.polarity,
        modality: statement.modality,
        assertedBy: statement.assertedBy,
        epistemicStatus: statement.epistemicStatus,
        confidence: statement.confidence,
        extractionModel: statement.extractionModel ?? null,
        extractionPromptHash: statement.extractionPromptHash ?? null,
        validFrom: statement.validFrom,
        validTo: statement.validTo,
        timePrecision: statement.timePrecision,
        validity: statement.validity,
        recordedAt: statement.recordedAt,
        contentHash: hash,
      },
    );
    if (created.records.length === 0) {
      throw new ConflictError(`statement ${statement.id} already exists with different immutable content`);
    }

    await tx.run(
      `MATCH (s:Statement {id: $id}), (subj:Entity {id: $subjectId})
       MERGE (s)-[:SUBJECT]->(subj)`,
      { id: statement.id, subjectId: statement.subjectId },
    );
    if (statement.objectKind === "entity" && statement.objectId) {
      await tx.run(
        `MATCH (s:Statement {id: $id}), (obj:Entity {id: $objectId})
         MERGE (s)-[:OBJECT]->(obj)`,
        { id: statement.id, objectId: statement.objectId },
      );
    }

    await tx.run(
      `MATCH (s:Statement {id: $id})
       WITH s
       UNWIND $evidence AS ev
       MERGE (e:Evidence {id: ev.id})
       ON CREATE SET e.kind = ev.kind, e.episodeId = ev.episodeId,
                     e.messageExternalId = ev.messageExternalId,
                     e.spanStart = ev.spanStart, e.spanEnd = ev.spanEnd, e.quote = ev.quote
       MERGE (s)-[:SUPPORTED_BY]->(e)
       WITH s, ev
       MATCH (ep:Episode {id: ev.episodeId})
       MERGE (ep)-[:ASSERTS]->(s)`,
      { id: statement.id, evidence },
    );

    return toStatement(created.records[0]!);
  }
}

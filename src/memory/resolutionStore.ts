import type { Driver, ManagedTransaction } from "neo4j-driver";
import { newSession } from "../interfaces/neo4j.js";
import type { ResolutionStore } from "../contracts/ports.js";
import type { Entity, MergeEvent, ResolutionOutcome, SplitEvent } from "../contracts/schemas.js";

/** Neo4j-backed, authoritative resolution store. All writes take a fenced tx. */
export class Neo4jResolutionStore implements ResolutionStore<ManagedTransaction> {
  constructor(private readonly driver: Driver) {}

  private async read<T>(cypher: string, params: Record<string, unknown> = {}): Promise<T[]> {
    const session = newSession(this.driver, "READ");
    try {
      const { records } = await session.run(cypher, params);
      return records.map((record) => record.get(0) as T);
    } finally {
      await session.close();
    }
  }

  async entities(): Promise<Entity[]> {
    const rows = await this.read<Record<string, unknown>>(
      "MATCH (e:Entity) RETURN properties(e) AS props ORDER BY e.id",
    );
    return rows.map(toEntity);
  }

  async entityById(id: string): Promise<Entity | null> {
    const rows = await this.read<Record<string, unknown>>(
      "MATCH (e:Entity {id: $id}) RETURN properties(e) AS props",
      { id },
    );
    return rows[0] ? toEntity(rows[0]) : null;
  }

  async statementIdsForEntity(entityId: string): Promise<string[]> {
    return this.read<string>(
      `MATCH (s:Statement)-[:SUBJECT|OBJECT]->(e:Entity {id: $id})
       RETURN s.id AS id ORDER BY id`,
      { id: entityId },
    );
  }

  async evidenceIdsForStatements(statementIds: string[]): Promise<string[]> {
    if (statementIds.length === 0) return [];
    return this.read<string>(
      `MATCH (s:Statement)-[:SUPPORTED_BY]->(ev:Evidence)
       WHERE s.id IN $ids RETURN ev.id AS id ORDER BY id`,
      { ids: statementIds },
    );
  }

  async mergeEdges(): Promise<{ from: string; to: string }[]> {
    const session = newSession(this.driver, "READ");
    try {
      const { records } = await session.run(
        "MATCH (a:Entity)-[:MERGED_INTO]->(b:Entity) RETURN a.id AS from, b.id AS to ORDER BY from, to",
      );
      return records.map((r) => ({ from: String(r.get("from")), to: String(r.get("to")) }));
    } finally {
      await session.close();
    }
  }

  async mergeEvent(id: string): Promise<MergeEvent | null> {
    const rows = await this.read<Record<string, unknown>>(
      "MATCH (e:MergeEvent {id: $id}) RETURN properties(e) AS props",
      { id },
    );
    return rows[0] ? toMergeEvent(rows[0]) : null;
  }

  async splitEvent(id: string): Promise<SplitEvent | null> {
    const rows = await this.read<Record<string, unknown>>(
      "MATCH (e:SplitEvent {id: $id}) RETURN properties(e) AS props",
      { id },
    );
    return rows[0] ? toSplitEvent(rows[0]) : null;
  }

  async mergeEvents(): Promise<MergeEvent[]> {
    const rows = await this.read<Record<string, unknown>>(
      "MATCH (e:MergeEvent) RETURN properties(e) AS props ORDER BY e.id",
    );
    return rows.map(toMergeEvent);
  }

  async splitEvents(): Promise<SplitEvent[]> {
    const rows = await this.read<Record<string, unknown>>(
      "MATCH (e:SplitEvent) RETURN properties(e) AS props ORDER BY e.id",
    );
    return rows.map(toSplitEvent);
  }

  async outcomes(): Promise<ResolutionOutcome[]> {
    const rows = await this.read<Record<string, unknown>>(
      "MATCH (o:ResolutionOutcome) RETURN properties(o) AS props ORDER BY o.id",
    );
    return rows.map(toOutcome);
  }

  async putEntity(tx: ManagedTransaction, entity: Entity): Promise<Entity> {
    await tx.run(
      `MERGE (e:Entity {id: $id})
       ON CREATE SET e.type = $type, e.canonicalName = $canonicalName, e.aliases = $aliases,
                     e.status = $status, e.createdAt = datetime($at), e.updatedAt = datetime($at)`,
      {
        id: entity.id, type: entity.type, canonicalName: entity.canonicalName,
        aliases: entity.aliases, status: entity.status, at: entity.createdAt,
      },
    );
    return entity;
  }

  async addAlias(tx: ManagedTransaction, entityId: string, aliases: string[]): Promise<void> {
    if (aliases.length === 0) return;
    const res = await tx.run("MATCH (e:Entity {id: $id}) RETURN coalesce(e.aliases, []) AS aliases", { id: entityId });
    const current = (res.records[0]?.get("aliases") as string[] | undefined) ?? [];
    const merged = [...new Set([...current, ...aliases])];
    if (merged.length === current.length) return;
    await tx.run(
      "MATCH (e:Entity {id: $id}) SET e.aliases = $aliases, e.updatedAt = datetime()",
      { id: entityId, aliases: merged },
    );
  }

  async applyResolution(
    tx: ManagedTransaction,
    args: { statementId: string; fromEntityId: string; toEntityId: string },
  ): Promise<void> {
    // Statement properties (id, evidence, subjectId/objectId, contentHash) stay
    // as extracted; only the graph's identity edges are re-pointed.
    await tx.run(
      `MATCH (s:Statement {id: $statementId})-[r:SUBJECT]->(from:Entity {id: $fromEntityId})
       DELETE r
       MERGE (s)-[:SUBJECT]->(to:Entity {id: $toEntityId})`,
      args,
    );
    await tx.run(
      `MATCH (s:Statement {id: $statementId})-[r:OBJECT]->(from:Entity {id: $fromEntityId})
       DELETE r
       MERGE (s)-[:OBJECT]->(to:Entity {id: $toEntityId})`,
      args,
    );
  }

  async putMerge(
    tx: ManagedTransaction,
    event: MergeEvent,
    sourceId: string,
    target: Entity,
  ): Promise<void> {
    const res = await tx.run("MATCH (e:Entity {id: $id}) RETURN coalesce(e.aliases, []) AS aliases", { id: target.id });
    const current = (res.records[0]?.get("aliases") as string[] | undefined) ?? [];
    await tx.run(
      `MATCH (s:Entity {id: $sourceId}), (t:Entity {id: $targetId})
       MERGE (s)-[:MERGED_INTO]->(t)
       SET s.status = 'merged', s.updatedAt = datetime($at)
       SET t.aliases = $aliases, t.updatedAt = datetime($at)
       WITH t
       MERGE (ev:MergeEvent {id: $id})
       ON CREATE SET ev.kind = 'merge', ev.sourceId = $sourceId, ev.targetId = $targetId,
                     ev.aliases = $eventAliases, ev.authorization = $authorization,
                     ev.reason = $reason, ev.planHash = $planHash, ev.recordedAt = datetime($at)`,
      {
        sourceId, targetId: target.id,
        aliases: [...new Set([...current, ...event.aliases])],
        id: event.id, eventAliases: event.aliases,
        authorization: event.authorization, reason: event.reason,
        planHash: event.planHash, at: event.recordedAt,
      },
    );
  }

  async putSplit(tx: ManagedTransaction, event: SplitEvent, source: Entity, created: Entity): Promise<void> {
    await tx.run(
      `MERGE (n:Entity {id: $id})
       ON CREATE SET n.type = $type, n.canonicalName = $canonicalName, n.aliases = $aliases,
                     n.status = $status, n.createdAt = datetime($at), n.updatedAt = datetime($at)`,
      {
        id: created.id, type: created.type, canonicalName: created.canonicalName,
        aliases: created.aliases, status: created.status, at: created.createdAt,
      },
    );
    await tx.run(
      `UNWIND $ids AS sid
       MATCH (s:Statement {id: sid})-[r:SUBJECT]->(src:Entity {id: $sourceId})
       DELETE r
       MERGE (s)-[:SUBJECT]->(n:Entity {id: $newId})`,
      { ids: event.statementIds, sourceId: event.sourceId, newId: created.id },
    );
    await tx.run(
      `UNWIND $ids AS sid
       MATCH (s:Statement {id: sid})-[r:OBJECT]->(src:Entity {id: $sourceId})
       DELETE r
       MERGE (s)-[:OBJECT]->(n:Entity {id: $newId})`,
      { ids: event.statementIds, sourceId: event.sourceId, newId: created.id },
    );
    await tx.run(
      `MATCH (src:Entity {id: $sourceId})
       SET src.status = 'split', src.aliases = $aliases, src.updatedAt = datetime($at)
       WITH src
       MERGE (ev:SplitEvent {id: $id})
       ON CREATE SET ev.kind = 'split', ev.sourceId = $sourceId, ev.newEntityId = $newId,
                     ev.statementIds = $statementIds, ev.evidenceIds = $evidenceIds,
                     ev.aliases = $eventAliases, ev.authorization = $authorization,
                     ev.reason = $reason, ev.planHash = $planHash, ev.recordedAt = datetime($at)`,
      {
        sourceId: event.sourceId,
        aliases: source.aliases.filter((a) => !event.aliases.includes(a)),
        at: event.recordedAt, id: event.id, newId: event.newEntityId,
        statementIds: event.statementIds, evidenceIds: event.evidenceIds,
        eventAliases: event.aliases, authorization: event.authorization,
        reason: event.reason, planHash: event.planHash,
      },
    );
  }

  async putOutcome(tx: ManagedTransaction, outcome: ResolutionOutcome): Promise<void> {
    await tx.run(
      `MERGE (o:ResolutionOutcome {id: $id})
       ON CREATE SET o.resolutionId = $resolutionId, o.episodeId = $episodeId,
                     o.statementId = $statementId, o.mentionName = $mentionName,
                     o.mentionType = $mentionType, o.outcome = $outcome,
                     o.fromEntityId = $fromEntityId, o.createdEntity = $createdEntity,
                     o.entityId = $entityId, o.candidates = $candidates,
                     o.rationale = $rationale, o.recordedAt = datetime($at)`,
      {
        id: outcome.id, resolutionId: outcome.resolutionId,
        episodeId: outcome.episodeId ?? null, statementId: outcome.statementId ?? null,
        mentionName: outcome.mentionName, mentionType: outcome.mentionType ?? null,
        outcome: outcome.outcome,
        fromEntityId: outcome.fromEntityId ?? null,
        createdEntity: outcome.createdEntity ? JSON.stringify(outcome.createdEntity) : null,
        entityId: outcome.entityId ?? null,
        candidates: JSON.stringify(outcome.candidates),
        rationale: outcome.rationale, at: outcome.recordedAt,
      },
    );
  }
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "toString" in value) {
    const text = String(value);
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
  }
  return "";
}

function toEntity(props: Record<string, unknown>): Entity {
  return {
    id: String(props.id),
    type: props.type as Entity["type"],
    canonicalName: String(props.canonicalName),
    aliases: (props.aliases as string[] | undefined) ?? [],
    externalIds: (props.externalIds as Record<string, string> | undefined) ?? undefined,
    status: (props.status as Entity["status"]) ?? "active",
    createdAt: iso(props.createdAt),
    updatedAt: iso(props.updatedAt),
  };
}

function toMergeEvent(props: Record<string, unknown>): MergeEvent {
  return {
    id: String(props.id), kind: "merge",
    sourceId: String(props.sourceId), targetId: String(props.targetId),
    aliases: (props.aliases as string[] | undefined) ?? [],
    authorization: String(props.authorization ?? ""), reason: String(props.reason ?? ""),
    planHash: String(props.planHash ?? ""), recordedAt: iso(props.recordedAt),
  };
}

function toSplitEvent(props: Record<string, unknown>): SplitEvent {
  return {
    id: String(props.id), kind: "split",
    sourceId: String(props.sourceId), newEntityId: String(props.newEntityId),
    statementIds: (props.statementIds as string[] | undefined) ?? [],
    evidenceIds: (props.evidenceIds as string[] | undefined) ?? [],
    aliases: (props.aliases as string[] | undefined) ?? [],
    authorization: String(props.authorization ?? ""), reason: String(props.reason ?? ""),
    planHash: String(props.planHash ?? ""), recordedAt: iso(props.recordedAt),
  };
}

function toOutcome(props: Record<string, unknown>): ResolutionOutcome {
  return {
    id: String(props.id), resolutionId: String(props.resolutionId),
    episodeId: props.episodeId == null ? undefined : String(props.episodeId),
    statementId: props.statementId == null ? undefined : String(props.statementId),
    mentionName: String(props.mentionName),
    mentionType: props.mentionType == null ? undefined : (props.mentionType as Entity["type"]),
    outcome: props.outcome as ResolutionOutcome["outcome"],
    fromEntityId: props.fromEntityId == null ? undefined : String(props.fromEntityId),
    createdEntity: typeof props.createdEntity === "string"
      ? JSON.parse(props.createdEntity)
      : (props.createdEntity as ResolutionOutcome["createdEntity"]),
    entityId: props.entityId == null ? undefined : String(props.entityId),
    candidates: typeof props.candidates === "string" ? JSON.parse(props.candidates) : (props.candidates as ResolutionOutcome["candidates"]),
    rationale: String(props.rationale ?? ""), recordedAt: iso(props.recordedAt),
  };
}

import type { Driver, ManagedTransaction } from "neo4j-driver";
import { newSession } from "../interfaces/neo4j.js";
import type { LifecycleStore } from "../contracts/ports.js";
import type { LifecycleEvent } from "../contracts/schemas.js";

/** Neo4j append-only lifecycle history. All writes take the caller's fenced tx. */
export class Neo4jLifecycleStore implements LifecycleStore<ManagedTransaction> {
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

  async events(): Promise<LifecycleEvent[]> {
    const rows = await this.read<Record<string, unknown>>(
      "MATCH (e:LifecycleEvent) RETURN properties(e) AS props ORDER BY e.id",
    );
    return rows.map(toEvent);
  }

  async event(id: string): Promise<LifecycleEvent | null> {
    const rows = await this.read<Record<string, unknown>>(
      "MATCH (e:LifecycleEvent {id: $id}) RETURN properties(e) AS props",
      { id },
    );
    return rows[0] ? toEvent(rows[0]) : null;
  }

  async edges(): Promise<{ kind: string; from: string; to: string }[]> {
    const session = newSession(this.driver, "READ");
    try {
      const { records } = await session.run(
        `MATCH (a)-[r:SUPERSEDES|RETRACTS|CONFLICTS_WITH|TARGETS]->(b)
         RETURN type(r) AS kind, coalesce(a.id, '') AS from, coalesce(b.id, '') AS to
         ORDER BY kind, from, to`,
      );
      return records.map((r) => ({
        kind: String(r.get("kind")), from: String(r.get("from")), to: String(r.get("to")),
      }));
    } finally {
      await session.close();
    }
  }

  async putEvent(tx: ManagedTransaction, event: LifecycleEvent): Promise<void> {
    await tx.run(
      `MERGE (ev:LifecycleEvent {id: $id})
       ON CREATE SET ev.kind = $kind, ev.targetId = $targetId,
                     ev.replacementId = $replacementId, ev.otherId = $otherId,
                     ev.at = datetime($at), ev.actor = $actor, ev.reason = $reason,
                     ev.jobId = $jobId, ev.claimGeneration = $claimGeneration,
                     ev.planHash = $planHash
       WITH ev
       MATCH (s:Statement {id: $targetId})
       MERGE (ev)-[:TARGETS]->(s)`,
      {
        id: event.id, kind: event.kind, targetId: event.targetId,
        replacementId: event.replacementId ?? null, otherId: event.otherId ?? null,
        at: event.at, actor: event.actor, reason: event.reason,
        jobId: event.jobId ?? null, claimGeneration: event.claimGeneration ?? null,
        planHash: event.planHash,
      },
    );
    if (event.kind === "superseded" && event.replacementId) {
      await tx.run(
        `MATCH (r:Statement {id: $replacementId}), (s:Statement {id: $targetId})
         MERGE (r)-[:SUPERSEDES]->(s)`,
        { replacementId: event.replacementId, targetId: event.targetId },
      );
    }
    if (event.kind === "retracted") {
      await tx.run(
        `MATCH (ev:LifecycleEvent {id: $id}), (s:Statement {id: $targetId})
         MERGE (ev)-[:RETRACTS]->(s)`,
        { id: event.id, targetId: event.targetId },
      );
    }
    if (event.kind === "conflicted" && event.otherId) {
      await tx.run(
        `MATCH (s:Statement {id: $targetId}), (o:Statement {id: $otherId})
         MERGE (s)-[:CONFLICTS_WITH]->(o)`,
        { targetId: event.targetId, otherId: event.otherId },
      );
    }
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

function toEvent(props: Record<string, unknown>): LifecycleEvent {
  return {
    id: String(props.id),
    kind: props.kind as LifecycleEvent["kind"],
    targetId: String(props.targetId),
    replacementId: props.replacementId == null ? undefined : String(props.replacementId),
    otherId: props.otherId == null ? undefined : String(props.otherId),
    at: iso(props.at),
    actor: String(props.actor ?? ""),
    reason: String(props.reason ?? ""),
    jobId: props.jobId == null ? undefined : String(props.jobId),
    claimGeneration: props.claimGeneration == null ? undefined : Number(props.claimGeneration),
    planHash: String(props.planHash ?? ""),
  };
}

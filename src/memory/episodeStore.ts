import type { Driver, Record, Session } from "neo4j-driver";
import { newSession } from "../interfaces/neo4j.js";

export type EpisodeRole = "user" | "assistant" | "system" | "tool";
export type EpisodeSource = "chat" | "api" | "import";
export type EpisodePrecision = "second" | "minute" | "day" | "month" | "year" | "unknown";

export interface EpisodeProps {
  id: string;
  externalId: string;
  sessionId: string;
  seq: number;
  role: EpisodeRole;
  text: string;
  occurredAt: Date;
  precision: EpisodePrecision;
  tz: string;
  source: EpisodeSource;
  createdAt: Date;
}

const asDate = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));

function toProps(r: Record): EpisodeProps {
  const e = r.get("e").properties;
  return {
    id: e.id,
    externalId: e.externalId,
    sessionId: e.sessionId,
    seq: e.seq,
    role: e.role,
    text: e.text,
    occurredAt: asDate(e.occurredAt),
    precision: e.precision,
    tz: e.tz,
    source: e.source,
    createdAt: asDate(e.createdAt),
  };
}

export class EpisodeStore {
  constructor(private readonly driver: Driver) {}

  async byId(id: string): Promise<EpisodeProps | null> {
    const s = newSession(this.driver, "READ");
    try {
      const { records } = await s.run("MATCH (e:Episode {id: $id}) RETURN e", { id });
      return records[0] ? toProps(records[0]) : null;
    } finally {
      await s.close();
    }
  }

  /** Half-open [from, to) UTC range — Episode.occurredAt is always stored in UTC. */
  async byOccurredRange(from: Date, to: Date, role?: EpisodeRole): Promise<EpisodeProps[]> {
    const s = newSession(this.driver, "READ");
    try {
      const q =
        role === undefined
          ? "MATCH (e:Episode) WHERE e.occurredAt >= datetime($from) AND e.occurredAt < datetime($to) RETURN e ORDER BY e.occurredAt, e.seq"
          : "MATCH (e:Episode) WHERE e.occurredAt >= datetime($from) AND e.occurredAt < datetime($to) AND e.role = $role RETURN e ORDER BY e.occurredAt, e.seq";
      const { records } = await s.run(q, { from: from.toISOString(), to: to.toISOString(), role });
      return records.map(toProps);
    } finally {
      await s.close();
    }
  }

  /** Full-text search over episode text (synchronous with commits — ADR-011). */
  async search(text: string): Promise<EpisodeProps[]> {
    const s = newSession(this.driver, "READ");
    try {
      const { records } = await s.run(
        "CALL db.index.fulltext.queryNodes('episode_text', $q) YIELD node AS e RETURN e ORDER BY e.occurredAt",
        { q: text },
      );
      return records.map(toProps);
    } finally {
      await s.close();
    }
  }

  /** Episodes with no completed extract job (reconciliation — ADR-010). */
  async withoutCompletedExtraction(olderThan: Date): Promise<EpisodeProps[]> {
    const s = newSession(this.driver, "READ");
    try {
      const { records } = await s.run(
        `MATCH (e:Episode) WHERE e.createdAt < datetime($olderThan)
         AND NOT EXISTS {
           MATCH (e)-[:PENDING_EXTRACTION]->(:Job {kind: 'extract', status: 'completed'})
         }
         RETURN e ORDER BY e.createdAt LIMIT 1000`,
        { olderThan: olderThan.toISOString() },
      );
      return records.map(toProps);
    } finally {
      await s.close();
    }
  }
}

import type { Episode } from "../contracts/schemas.js";
import type { EpisodeStore } from "./episodeStore.js";

/** Minimal read port used by extraction. Keeps the Slice 1 Date-based store untouched. */
export interface EpisodeReader {
  byId(id: string): Promise<Episode | null>;
}

/** Adapt Slice 1's Date-based EpisodeStore to the contract's ISO-string Episode. */
export class Neo4jEpisodeReader implements EpisodeReader {
  constructor(private readonly store: EpisodeStore) {}

  async byId(id: string): Promise<Episode | null> {
    const p = await this.store.byId(id);
    if (!p) return null;
    return {
      id: p.id,
      externalId: p.externalId,
      sessionId: p.sessionId,
      seq: p.seq,
      role: p.role,
      text: p.text,
      occurredAt: p.occurredAt.toISOString(),
      precision: p.precision,
      tz: p.tz,
      source: p.source,
      createdAt: p.createdAt.toISOString(),
    };
  }
}

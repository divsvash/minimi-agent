import type { Episode } from "../contracts/schemas.js";
import type { EpisodeStore } from "../contracts/ports.js";

/**
 * Deterministic in-memory EpisodeStore for offline evaluation.
 * Mirrors the Slice 1 semantics (verbatim, occurredAt in UTC, half-open range,
 * ORDER BY occurredAt, seq). No Neo4j required. Raw conversation stays sacred:
 * text is stored and returned byte-identical.
 */
export class InMemoryEpisodeStore implements EpisodeStore {
  private readonly episodes = new Map<string, Episode>();

  seed(episodes: Episode[]): this {
    for (const e of episodes) this.episodes.set(e.id, structuredClone(e));
    return this;
  }

  async byId(id: string): Promise<Episode | null> {
    const e = this.episodes.get(id);
    return e ? structuredClone(e) : null;
  }

  async byOccurredRange(from: Date, to: Date, role?: Episode["role"]): Promise<Episode[]> {
    return [...this.episodes.values()]
      .filter((e) => {
        const t = new Date(e.occurredAt);
        return t >= from && t < to && (role === undefined || e.role === role);
      })
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.seq - b.seq)
      .map((e) => structuredClone(e));
  }

  /** Naive substring search — intentionally dumb; FT-quality matching is Slice 6/Neo4j territory. */
  async search(text: string): Promise<Episode[]> {
    const q = text.toLowerCase();
    return [...this.episodes.values()]
      .filter((e) => e.text.toLowerCase().includes(q))
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.seq - b.seq)
      .map((e) => structuredClone(e));
  }

  async withoutCompletedExtraction(olderThan: Date): Promise<Episode[]> {
    // In-memory fake has no job linkage; report all old episodes as pending reconciliation.
    return [...this.episodes.values()]
      .filter((e) => new Date(e.createdAt) < olderThan)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((e) => structuredClone(e));
  }

  get size(): number {
    return this.episodes.size;
  }

  clear(): void {
    this.episodes.clear();
  }
}

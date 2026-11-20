import type { Episode } from "../contracts/schemas.js";
import type { EpisodeStore } from "../contracts/ports.js";

/**
 * Deterministic in-memory EpisodeStore for offline evaluation.
 * Mirrors the Slice 1 semantics (verbatim, occurredAt in UTC, half-open range,
 * ORDER BY occurredAt, seq). No Neo4j required. Raw conversation stays sacred:
 * text is stored and returned byte-identical.
 *
 * Extraction-job state is modeled as the single completion bit that
 * `withoutCompletedExtraction` needs (production link:
 * `(e)-[:PENDING_EXTRACTION]->(:Job {kind:'extract', status:'completed'})`).
 * It does NOT model job attempts, failures, leases, or multiple jobs per episode.
 */
export class InMemoryEpisodeStore implements EpisodeStore {
  private readonly episodes = new Map<string, Episode>();
  private readonly completedExtraction = new Set<string>();

  seed(episodes: Episode[]): this {
    for (const e of episodes) this.episodes.set(e.id, structuredClone(e));
    return this;
  }

  /** Test seam: mark the episode's extract job completed. */
  markExtractionCompleted(episodeId: string): this {
    this.requireEpisode(episodeId);
    this.completedExtraction.add(episodeId);
    return this;
  }

  /** Test seam: clear completion, e.g. after re-enqueueing extraction. */
  markExtractionPending(episodeId: string): this {
    this.requireEpisode(episodeId);
    this.completedExtraction.delete(episodeId);
    return this;
  }

  async byId(id: string): Promise<Episode | null> {
    const e = this.episodes.get(id);
    return e ? structuredClone(e) : null;
  }

  async byOccurredRange(from: Date, to: Date, role?: Episode["role"]): Promise<Episode[]> {
    if (from.getTime() >= to.getTime()) return []; // invalid range ⇒ empty, matching the Neo4j store
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
    return [...this.episodes.values()]
      .filter((e) => new Date(e.createdAt) < olderThan && !this.completedExtraction.has(e.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((e) => structuredClone(e));
  }

  private requireEpisode(id: string): void {
    if (!this.episodes.has(id)) throw new Error(`unknown episode: ${id}`);
  }

  get size(): number {
    return this.episodes.size;
  }

  clear(): void {
    this.episodes.clear();
    this.completedExtraction.clear();
  }
}

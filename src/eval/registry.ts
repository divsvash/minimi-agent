import { z } from "zod";
import { dayRangeUtc } from "../core/time.js";
import { EpisodeSchema, type Episode } from "../contracts/schemas.js";
import { InMemoryEpisodeStore } from "../fakes/memoryEpisodeStore.js";
import { extractionEpisodeHandler } from "./extractionSut.js";
import type { SutRegistry } from "./harness.js";

/**
 * System-under-test handlers. Only what is actually built and verifiable offline
 * is registered. Each entry names the slice that delivered it; everything else
 * stays declarative (validated and drift-checked, reported as `pending`).
 */

const DayRangeInput = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), tz: z.string().min(1) });

const RecallInput = z.object({
  episodes: z.array(EpisodeSchema),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tz: z.string().min(1),
  role: z.enum(["user", "assistant", "system", "tool"]).optional(),
});

const episodeSummary = (e: Episode) => ({
  id: e.id,
  sessionId: e.sessionId,
  seq: e.seq,
  role: e.role,
  text: e.text,
  occurredAt: e.occurredAt,
  precision: e.precision,
});

export const sutRegistry: SutRegistry = {
  /** Pure tz/day-boundary math (slice 1 primitive, reused verbatim). */
  "time.dayRange": async (input) => {
    const { date, tz } = DayRangeInput.parse(input);
    const { from, to } = dayRangeUtc(date, tz);
    return { fromUtc: from.toISOString(), toUtc: to.toISOString() };
  },

  /**
   * Verbatim day-scoped recall over an in-memory store — the offline twin of
   * Slice 1's /recall (dayRangeUtc + half-open range + occurredAt/seq order).
   * No extraction, retrieval, or synthesis involved (ADR-011/ADR-012 boundaries).
   */
  "episode.recall": async (input) => {
    const { episodes, date, tz, role } = RecallInput.parse(input);
    const store = new InMemoryEpisodeStore();
    store.seed(episodes);
    const { from, to } = dayRangeUtc(date, tz);
    const items = await store.byOccurredRange(from, to, role);
    return {
      interpretedAs: { date, tz, fromUtc: from.toISOString(), toUtc: to.toISOString() },
      episodes: items.map(episodeSummary),
    };
  },

  /**
   * Slice 3 extraction: episode -> provider -> validated candidates -> fenced
   * commit -> provenance-backed statements. Runs the real worker/handler/store
   * over a fake provider and an offline fence twin; every output is labelled
   * `provider: fake-llm-1` and `semanticQuality: not_measured`.
   */
  "extraction.episode": extractionEpisodeHandler,
};

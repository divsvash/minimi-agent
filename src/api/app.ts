import express from "express";
import { z } from "zod";
import { neo4jConfigFromEnv, createDriver } from "../interfaces/neo4j.js";
import { EpisodeStore } from "../memory/episodeStore.js";
import { JobLedger } from "../jobs/ledger.js";
import { buildIngestion } from "../ingestion/ingestMessage.js";
import { dayRangeUtc } from "../core/time.js";
import { noopTelemetry, MemoryTelemetry } from "../core/telemetry.js";

const IngestSchema = z.object({
  sessionId: z.string().min(1),
  text: z.string().min(1),
  role: z.enum(["user", "assistant", "system", "tool"]).default("user"),
  seq: z.number().int().optional(),
  occurredAt: z.string().datetime().optional(),
  precision: z.enum(["second", "minute", "day", "month", "year", "unknown"]).optional(),
  tz: z.string().min(1).default("UTC"),
  source: z.enum(["chat", "api", "import"]).default("chat"),
});

export function createApp(deps?: { telemetry?: MemoryTelemetry }) {
  const telemetry = deps?.telemetry ?? noopTelemetry;
  const cfg = neo4jConfigFromEnv();
  const driver = createDriver(cfg);
  const { ingestion, ledger } = buildIngestion();
  const episodes = new EpisodeStore(driver);

  const app = express();
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", (_req, res) => res.json({ ok: true }));

  /** Ingest one conversational turn. Episode + outbox job commit atomically. */
  app.post("/episodes", async (req, res) => {
    const parsed = IngestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const p = parsed.data;
    const t0 = Date.now();
    try {
      const result = await ingestion.ingestMessage({
        ...p,
        occurredAt: p.occurredAt ? new Date(p.occurredAt) : undefined,
      });
      telemetry.incr("ingest.total");
      telemetry.timing("ingest.ms", Date.now() - t0);
      res.status(result.created ? 201 : 200).json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /** Verbatim recall for a local calendar day, e.g. /recall?date=2026-11-03&tz=Europe/Lisbon */
  app.get("/recall", async (req, res) => {
    const date = String(req.query.date ?? "");
    const tz = String(req.query.tz ?? "UTC");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    }
    try {
      const { from, to } = dayRangeUtc(date, tz);
      const items = await episodes.byOccurredRange(from, to);
      // "interpreted as" echo — mandatory per architecture.md §4/§5
      res.json({
        interpretedAs: { date, tz, fromUtc: from.toISOString(), toUtc: to.toISOString() },
        episodes: items.map((e) => ({
          id: e.id, sessionId: e.sessionId, seq: e.seq, role: e.role, text: e.text,
          occurredAt: e.occurredAt, precision: e.precision,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /** Full-text search over what was said. */
  app.get("/search", async (req, res) => {
    const q = String(req.query.q ?? "");
    if (!q.trim()) return res.status(400).json({ error: "q required" });
    const items = await episodes.search(q);
    res.json({ query: q, episodes: items });
  });

  /** Dead-letter visibility + manual re-drive (ADR-010). */
  app.get("/jobs/dead", async (_req, res) => res.json({ jobs: await ledger.deadJobs() }));
  app.post("/jobs/:id/redrive", async (req, res) => {
    await ledger.redrive(req.params.id);
    res.json({ ok: true });
  });

  return { app, driver };
}

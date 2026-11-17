import express from "express";
import { z } from "zod";
import { buildIngestion } from "../ingestion/ingestMessage.js";
import { dayRangeUtc } from "../core/time.js";
import { noopTelemetry, MemoryTelemetry } from "../core/telemetry.js";
import type { Request, Response, NextFunction, RequestHandler } from "express";

/** Express 4 does not forward rejected async handlers to error middleware — wrap them. */
const ah = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => void fn(req, res, next).catch(next);

const IngestSchema = z.object({
  messageId: z.string().min(1).max(200).optional(),
  sessionId: z.string().min(1),
  text: z.string().min(1),
  role: z.enum(["user", "assistant", "system", "tool"]).default("user"),
  seq: z.number().int().optional(),
  occurredAt: z.string().datetime().optional(),
  precision: z.enum(["second", "minute", "day", "month", "year", "unknown"]).optional(),
  tz: z.string().min(1).default("UTC"),
  source: z.enum(["chat", "api", "import"]).default("chat"),
});

export interface AppDeps {
  driver: import("neo4j-driver").Driver; // ONE shared driver — created in index.ts, closed on shutdown
  telemetry?: MemoryTelemetry;
}

export function createApp(deps: AppDeps) {
  const telemetry = deps.telemetry ?? noopTelemetry;
  const { driver } = deps;
  const { ingestion, ledger, episodes } = buildIngestion(driver);

  const app = express();
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", (_req, res) => res.json({ ok: true }));

  /** Ingest one conversational turn. Episode + outbox job commit atomically. */
  app.post("/episodes", ah(async (req, res) => {
    const parsed = IngestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const p = parsed.data;
    const t0 = Date.now();
    const result = await ingestion.ingestMessage({
      ...p,
      occurredAt: p.occurredAt ? new Date(p.occurredAt) : undefined,
    });
    telemetry.incr("ingest.total");
    telemetry.timing("ingest.ms", Date.now() - t0);
    res.status(result.created ? 201 : 200).json(result);
  }));

  /** Verbatim recall for a local calendar day, e.g. /recall?date=2026-11-03&tz=Europe/Lisbon */
  app.get("/recall", ah(async (req, res) => {
    const date = String(req.query.date ?? "");
    const tz = String(req.query.tz ?? "UTC");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: "date must be YYYY-MM-DD" });
      return;
    }
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
  }));

  /** Full-text search over what was said. */
  app.get("/search", ah(async (req, res) => {
    const q = String(req.query.q ?? "");
    if (!q.trim()) {
      res.status(400).json({ error: "q required" });
      return;
    }
    const items = await episodes.search(q);
    res.json({ query: q, episodes: items });
  }));

  /** Dead-letter visibility + manual re-drive (ADR-010). */
  app.get("/jobs/dead", ah(async (_req, res) => {
    res.json({ jobs: await ledger.deadJobs() });
  }));
  app.post("/jobs/:id/redrive", ah(async (req, res) => {
    await ledger.redrive(String(req.params.id));
    res.json({ ok: true });
  }));

  // Final error middleware — unexpected failures become controlled 500s, never unhandled rejections
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    console.error("unhandled request error:", err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: "internal_error" });
  });

  return { app };
}

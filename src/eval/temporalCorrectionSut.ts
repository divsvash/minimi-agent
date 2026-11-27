import { z } from "zod";
import { fixedClock } from "../core/clock.js";
import {
  EpisodePrecisionSchema, LifecycleEventSchema, ModalitySchema, PolaritySchema, ValiditySchema,
  type CorrectionPlan, type LifecycleEvent,
} from "../contracts/schemas.js";
import type { StatementWrite } from "../contracts/ports.js";
import { InMemoryJobLedger } from "../fakes/memoryJobLedger.js";
import { InMemoryLifecycleStore } from "../fakes/memoryLifecycleStore.js";
import { InMemoryStatementStore } from "../fakes/memoryStatementStore.js";
import { statementContentHash } from "../memory/statementContent.js";
import { JobWorker } from "../jobs/worker.js";
import { CorrectionJobHandler } from "../temporal/correctionJobHandler.js";
import { CorrectionService } from "../temporal/correctionService.js";
import { projectStatus } from "../temporal/projection.js";
import type { SutHandler } from "./harness.js";

/**
 * Slice 5 SUT: real CorrectionService + JobWorker + lifecycle store over
 * deterministic fakes. Scenario statements are compact; the harness expands
 * them into validated StatementWrites with evidence and mention entities.
 * No model is involved — temporal correctness is measured, not semantics.
 */

const SimpleStatementSchema = z.object({
  id: z.string().min(1),
  subjectId: z.string().min(1).default("ent:subj"),
  predicate: z.string().min(1),
  objectKind: z.enum(["entity", "literal"]).default("literal"),
  objectId: z.string().optional(),
  objectValue: z.string().default("value"),
  polarity: PolaritySchema.default("positive"),
  modality: ModalitySchema.default("asserted"),
  recordedAt: z.string(),
  validFrom: z.string().nullable().default(null),
  validTo: z.string().nullable().default(null),
  timePrecision: EpisodePrecisionSchema.default("unknown"),
  validity: ValiditySchema.default("open_ended"),
  confidence: z.number().min(0).max(1).default(0.8),
  episodeId: z.string().default("ep-eval"),
  quote: z.string().default("quoted evidence"),
});
type SimpleStatement = z.infer<typeof SimpleStatementSchema>;

const CorrectionInput = z.object({
  kind: z.enum(["supersede", "retract", "conflict"]),
  targetId: z.string().min(1),
  /** "$target" is a fixture shorthand resolved by the harness before the job. */
  expectedFingerprint: z.string().min(1).default("$target"),
  replacement: SimpleStatementSchema.optional(),
  otherId: z.string().min(1).optional(),
  otherFingerprint: z.string().min(1).default("$other"),
  reason: z.string().min(1).default("evaluation correction"),
  actor: z.string().min(1).default("eval"),
});

const TemporalInput = z.object({
  mode: z.enum(["query", "correct"]).default("query"),
  statements: z.array(SimpleStatementSchema).default([]),
  events: z.array(LifecycleEventSchema).default([]),
  correction: CorrectionInput.optional(),
  query: z.object({
    asOfValid: z.string().optional(),
    asOfTx: z.string().optional(),
    subjectId: z.string().optional(),
    predicate: z.string().optional(),
  }).default({}),
  staleFence: z.boolean().default(false),
  repeats: z.number().int().min(1).max(3).default(1),
});

function toWrite(s: SimpleStatement): StatementWrite {
  const objectId = s.objectKind === "entity" ? (s.objectId ?? `ent:${s.id}-object`) : undefined;
  return {
    statement: {
      id: s.id,
      subjectId: s.subjectId,
      predicate: s.predicate,
      objectKind: s.objectKind,
      ...(objectId ? { objectId } : { objectValue: s.objectValue }),
      polarity: s.polarity,
      modality: s.modality,
      assertedBy: "user",
      epistemicStatus: "user_asserted",
      confidence: s.confidence,
      validFrom: s.validFrom,
      validTo: s.validTo,
      timePrecision: s.timePrecision,
      validity: s.validity,
      recordedAt: s.recordedAt,
    },
    evidence: [{
      id: `ev:${s.id}`,
      kind: "episode_span",
      episodeId: s.episodeId,
      messageExternalId: `ext:${s.episodeId}`,
      spanStart: 0,
      spanEnd: s.quote.length,
      quote: s.quote,
    }],
    entities: [
      {
        id: s.subjectId, type: "concept", canonicalName: "Subject", aliases: [],
        status: "active", createdAt: s.recordedAt, updatedAt: s.recordedAt,
      },
      ...(objectId ? [{
        id: objectId, type: "product" as const, canonicalName: "Object", aliases: [],
        status: "active" as const, createdAt: s.recordedAt, updatedAt: s.recordedAt,
      }] : []),
    ],
  };
}

export const temporalCorrectionHandler: SutHandler = async (input) => {
  const cfg = TemporalInput.parse(input);
  const clock = fixedClock(new Date("2026-11-20T00:00:00.000Z"));
  const lifecycle = new InMemoryLifecycleStore();
  const statements = new InMemoryStatementStore(lifecycle);

  for (const simple of cfg.statements) await statements.insert({}, toWrite(simple));
  for (const event of cfg.events) await lifecycle.putEvent({}, event);

  let status = "ok";
  let error: string | null = null;
  const outcomes: string[] = [];

  if (cfg.mode === "correct" && cfg.correction) {
    const c = cfg.correction;
    const target = await statements.byId(c.targetId);
    if (!target) {
      status = "rejected";
      error = `target ${c.targetId} does not exist`;
    } else {
      const fingerprint = c.expectedFingerprint === "$target"
        ? statementContentHash(target)
        : c.expectedFingerprint;
      const plan: CorrectionPlan = c.kind === "supersede"
        ? {
          kind: "supersede", targetId: c.targetId, expectedFingerprint: fingerprint,
          replacement: c.replacement ? toWrite(c.replacement) : undefined,
          reason: c.reason, actor: c.actor,
        }
        : c.kind === "retract"
          ? { kind: "retract", targetId: c.targetId, expectedFingerprint: fingerprint, reason: c.reason, actor: c.actor }
          : {
            kind: "conflict", targetId: c.targetId, expectedFingerprint: fingerprint,
            otherId: c.otherId ?? "",
            otherFingerprint: c.otherFingerprint === "$other"
              ? statementContentHash((await statements.byId(c.otherId ?? ""))!)
              : c.otherFingerprint,
            reason: c.reason, actor: c.actor,
          };

      const ledger = new InMemoryJobLedger();
      const worker = new JobWorker<object>(
        ledger,
        [new CorrectionJobHandler(new CorrectionService(statements, lifecycle, { clock }))],
        { workerId: "eval-correct-worker", leaseRenewMs: 0, idleDelayMs: 0 },
      );
      if (cfg.staleFence) ledger.failNextFence(1);
      for (let run = 0; run < cfg.repeats; run++) {
        ledger.enqueue("correct", { plan }, `correct:${c.targetId}:${run}`, { maxAttempts: 1 });
        const outcome = await worker.runOnce();
        outcomes.push(outcome);
      }
      if (outcomes.some((o) => o === "dead" || o === "stale")) {
        const jobs = ledger.jobs();
        error = jobs.map((j) => j.lastError).filter((e): e is string => e !== null).at(-1)
          ?? "correction did not commit";
        status = "rejected";
      }
    }
  }

  const events = await lifecycle.events();
  const edges = await lifecycle.edges();
  const query = cfg.query;
  const results = await statements.activeAt({
    asOfValid: query.asOfValid ? new Date(query.asOfValid) : undefined,
    asOfTx: query.asOfTx ? new Date(query.asOfTx) : undefined,
    subjectId: query.subjectId,
    predicate: query.predicate,
  });

  return {
    status,
    error,
    outcomes,
    counts: {
      statements: statements.size,
      queryStatements: results.length,
      events: events.length,
      supersedeEdges: edges.filter((e) => e.kind === "SUPERSEDES").length,
      retractEdges: edges.filter((e) => e.kind === "RETRACTS").length,
      conflictEdges: new Set(
        edges.filter((e) => e.kind === "CONFLICTS_WITH").map((e) => [e.from, e.to].sort().join("|")),
      ).size,
    },
    queryResult: results.map((s) => ({ id: s.id, recordedAt: s.recordedAt })),
    statements: (await Promise.all(
      statements.allStatements().map(async (s) => ({
        id: s.id,
        status: projectStatus(s.id, events),
        recordedAt: s.recordedAt,
        validFrom: s.validFrom,
        validTo: s.validTo,
        contentHash: statementContentHash(s),
      })),
    )),
    events: events.map((e: LifecycleEvent) => ({
      id: e.id, kind: e.kind, targetId: e.targetId,
      replacementId: e.replacementId ?? null, otherId: e.otherId ?? null,
      at: e.at,
    })),
    edges,
    provider: null,
    semanticQuality: "not_measured",
  };
};

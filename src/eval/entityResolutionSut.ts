import { z } from "zod";
import { fixedClock } from "../core/clock.js";
import { ValidationError } from "../core/errors.js";
import {
  EntitySchema, EpisodeSchema, MergePlanSchema, ResolutionRequestSchema, SplitPlanSchema,
} from "../contracts/schemas.js";
import { ExtractionService } from "../extraction/extractEpisode.js";
import { ExtractionJobHandler } from "../extraction/extractionJobHandler.js";
import { InMemoryJobLedger } from "../fakes/memoryJobLedger.js";
import { InMemoryResolutionStore } from "../fakes/memoryResolutionStore.js";
import { ScriptedEmbeddingProvider } from "../fakes/scriptedEmbeddingProvider.js";
import { InMemoryStatementStore } from "../fakes/memoryStatementStore.js";
import { FakeLLMProvider } from "../fakes/providers.js";
import { JobWorker } from "../jobs/worker.js";
import { EntityResolutionService } from "../resolution/service.js";
import type { SutHandler } from "./harness.js";

/**
 * Slice 4 system-under-test. Runs the REAL resolution service, policy and
 * candidate generator over deterministic fakes. Embeddings are scripted vectors
 * from the fixture — no model is called, so no semantic quality is claimed.
 */

const LinkSeed = z.object({
  entityId: z.string().min(1),
  statementIds: z.array(z.string().min(1)).default([]),
  evidenceIds: z.array(z.string().min(1)).default([]),
});

const EntityResolutionInput = z.object({
  mode: z.enum(["resolve", "merge", "split", "extract"]).default("resolve"),
  entities: z.array(EntitySchema).default([]),
  episode: EpisodeSchema.optional(),
  responses: z.array(z.string()).default([]),
  request: ResolutionRequestSchema.optional(),
  merge: MergePlanSchema.optional(),
  split: SplitPlanSchema.optional(),
  links: z.array(LinkSeed).default([]),
  edges: z.array(z.object({ from: z.string().min(1), to: z.string().min(1) })).default([]),
  embeddings: z.record(z.array(z.number())).optional(),
  /** Repeat the operation to probe merge/split idempotency. */
  repeats: z.number().int().min(1).max(3).default(1),
});

export const entityResolutionHandler: SutHandler = async (input) => {
  const cfg = EntityResolutionInput.parse(input);
  const clock = fixedClock(new Date("2026-11-23T00:00:00.000Z"));
  const statements = new InMemoryStatementStore();
  const resolutions = new InMemoryResolutionStore(statements, clock);
  for (const entity of cfg.entities) await resolutions.putEntity({}, entity);
  for (const link of cfg.links) resolutions.seedLinks(link.entityId, link.statementIds, link.evidenceIds);
  for (const edge of cfg.edges) resolutions.seedMergeEdge(edge.from, edge.to);

  const embeddings = cfg.embeddings ? new ScriptedEmbeddingProvider(cfg.embeddings) : undefined;
  const service = new EntityResolutionService(resolutions, { clock, embeddings });

  let status: "ok" | "rejected" = "ok";
  let error: string | null = null;
  let decision: Record<string, unknown> | null = null;
  let event: Record<string, unknown> | null = null;

  try {
    const attempts = cfg.mode === "extract" ? 1 : cfg.repeats;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (cfg.mode === "extract") {
        if (!cfg.episode) throw new ValidationError("extract mode requires an episode");
        let call = 0;
        const responseText = () => {
          const text = cfg.responses[Math.min(call, cfg.responses.length - 1)] ?? JSON.stringify({ candidates: [] });
          call += 1;
          return text;
        };
        const provider = new FakeLLMProvider(() => ({
          text: responseText(),
          model: "fake-llm-1",
          usage: { inputTokens: 100, outputTokens: 50 },
          finishReason: "stop",
        }));
        const handler = new ExtractionJobHandler<object>({
          episodes: { byId: async (id) => (id === cfg.episode!.id ? cfg.episode! : null) },
          extractor: new ExtractionService({ provider, clock, timeoutMs: 0 }),
          statements,
          resolver: service,
          resolutions,
          clock,
        });
        const ledger = new InMemoryJobLedger();
        const worker = new JobWorker<object>(ledger, [handler], {
          workerId: "eval-resolve-worker", leaseRenewMs: 0, idleDelayMs: 0,
        });
        ledger.enqueue("extract", { episodeId: cfg.episode.id }, `extract:${cfg.episode.id}`, { maxAttempts: 1 });
        const jobOutcome = await worker.runOnce();
        if (jobOutcome !== "completed") throw new ValidationError(`extract job ended as ${jobOutcome}`);
      } else if (cfg.mode === "resolve") {
        if (!cfg.request) throw new ValidationError("resolve mode requires a request");
        const result = await service.resolve(cfg.request);
        decision = {
          outcome: result.outcome,
          entityId: "entityId" in result ? result.entityId : null,
          resolutionId: result.resolutionId,
          rationale: result.rationale,
          candidateCount: result.candidates.length,
          signals: result.candidates.map((c) => c.signals.map((s) => s.kind)),
        };
      } else if (cfg.mode === "merge") {
        if (!cfg.merge) throw new ValidationError("merge mode requires a merge plan");
        const merged = await service.merge({}, cfg.merge);
        event = {
          id: merged.id,
          kind: merged.kind,
          sourceId: merged.sourceId,
          targetId: merged.targetId,
          aliases: merged.aliases,
          authorization: merged.authorization,
        };
      } else {
        if (!cfg.split) throw new ValidationError("split mode requires a split plan");
        const split = await service.split({}, cfg.split);
        event = {
          id: split.id,
          kind: split.kind,
          sourceId: split.sourceId,
          newEntityId: split.newEntityId,
          statementIds: split.statementIds,
          evidenceIds: split.evidenceIds,
          aliases: split.aliases,
          authorization: split.authorization,
        };
      }
    }
  } catch (err) {
    status = "rejected";
    error = err instanceof Error ? err.message : String(err);
  }

  const [entities, edges, mergeEvents, splitEvents, outcomes] = await Promise.all([
    resolutions.entities(),
    resolutions.mergeEdges(),
    resolutions.mergeEvents(),
    resolutions.splitEvents(),
    resolutions.outcomes(),
  ]);
  const allStatements = statements.allStatements();
  const applied = await Promise.all(outcomes
    .filter((o) => o.entityId && o.fromEntityId)
    .map(async (o) => ({
      statementId: o.statementId ?? null,
      fromEntityId: o.fromEntityId,
      toEntityId: o.entityId,
      outcome: o.outcome,
      graphHasReference: o.statementId
        ? (await resolutions.statementIdsForEntity(o.entityId!)).includes(o.statementId)
        : false,
      persistedEntity: Boolean(await resolutions.entityById(o.entityId!)),
    })));

  return {
    status,
    error,
    mode: cfg.mode,
    decision,
    event,
    counts: {
      entities: entities.length,
      statements: allStatements.length,
      applied: applied.length,
      mergeEdges: edges.length,
      mergeEvents: mergeEvents.length,
      splitEvents: splitEvents.length,
      outcomes: outcomes.length,
    },
    entities: entities.map((e) => ({
      id: e.id,
      type: e.type,
      canonicalName: e.canonicalName,
      aliases: e.aliases,
      status: e.status,
    })),
    statements: allStatements.map((s) => ({
      id: s.id,
      subjectId: s.subjectId,
      objectId: s.objectId ?? null,
      evidenceCount: statements.evidenceFor(s.id).length,
    })),
    applied,
    edges: edges.map((e) => ({ from: e.from, to: e.to })),
    mergeEvents: mergeEvents.map((e) => ({ id: e.id, sourceId: e.sourceId, targetId: e.targetId, aliases: e.aliases })),
    splitEvents: splitEvents.map((e) => ({
      id: e.id,
      sourceId: e.sourceId,
      newEntityId: e.newEntityId,
      statementIds: e.statementIds,
      evidenceIds: e.evidenceIds,
      aliases: e.aliases,
    })),
    outcomes: outcomes.map((o) => ({ id: o.id, outcome: o.outcome, mentionName: o.mentionName, entityId: o.entityId ?? null })),
    provider: embeddings?.model ?? null,
    semanticQuality: "not_measured",
  };
};

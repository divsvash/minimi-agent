import { z } from "zod";
import { fixedClock } from "../core/clock.js";
import { ValidationError } from "../core/errors.js";
import {
  EntitySchema, MergePlanSchema, ResolutionRequestSchema, SplitPlanSchema,
} from "../contracts/schemas.js";
import { InMemoryResolutionStore } from "../fakes/memoryResolutionStore.js";
import { ScriptedEmbeddingProvider } from "../fakes/scriptedEmbeddingProvider.js";
import { InMemoryStatementStore } from "../fakes/memoryStatementStore.js";
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
  mode: z.enum(["resolve", "merge", "split"]).default("resolve"),
  entities: z.array(EntitySchema).default([]),
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
    for (let attempt = 0; attempt < cfg.repeats; attempt++) {
      if (cfg.mode === "resolve") {
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

  return {
    status,
    error,
    mode: cfg.mode,
    decision,
    event,
    counts: {
      entities: entities.length,
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

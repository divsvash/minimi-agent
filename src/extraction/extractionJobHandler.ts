import { z } from "zod";
import { noopTelemetry, type Telemetry } from "../core/telemetry.js";
import { systemClock, type Clock } from "../core/clock.js";
import { ids } from "../core/ids.js";
import { NotFoundError, ValidationError } from "../core/errors.js";
import type { EntityResolver, ResolutionStore, StatementStore } from "../contracts/ports.js";
import type { ResolutionOutcome } from "../contracts/schemas.js";
import type { EpisodeReader } from "../memory/episodeReader.js";
import type { JobHandler, PreparedJob, WorkerJob } from "../jobs/worker.js";
import type { ExtractionService } from "./extractEpisode.js";

const ExtractPayloadSchema = z.object({ episodeId: z.string().min(1) });

export interface ExtractionJobHandlerDeps<TX extends object> {
  episodes: EpisodeReader;
  extractor: ExtractionService;
  statements: StatementStore<TX>;
  telemetry?: Telemetry;
  /** Slice 4: optional, injected together. Without both, Slice 3 behavior is unchanged. */
  resolver?: EntityResolver;
  resolutions?: ResolutionStore<TX>;
  clock?: Clock;
}

/**
 * The only job handler shipped in Slice 3: episode -> validated candidates.
 *
 * Generic over the store transaction handle so the SAME handler runs against
 * Neo4j (`ManagedTransaction`) in integration tests and against the offline
 * in-memory store (`object`) in unit tests and evaluation.
 */
export class ExtractionJobHandler<TX extends object> implements JobHandler<TX> {
  readonly kind = "extract";
  private readonly telemetry: Telemetry;

  constructor(private readonly deps: ExtractionJobHandlerDeps<TX>) {
    this.telemetry = deps.telemetry ?? noopTelemetry;
  }

  async prepare(job: WorkerJob): Promise<PreparedJob<TX>> {
    let payload: unknown;
    try {
      payload = JSON.parse(job.payloadJson);
    } catch {
      throw new ValidationError("extract job payload is not valid JSON");
    }
    const parsed = ExtractPayloadSchema.safeParse(payload);
    if (!parsed.success) throw new ValidationError("extract job payload requires episodeId", parsed.error.issues);

    const episode = await this.deps.episodes.byId(parsed.data.episodeId);
    if (!episode) throw new NotFoundError(`episode ${parsed.data.episodeId} does not exist`);

    const result = await this.deps.extractor.extractEpisode(episode);
    this.telemetry.incr("extraction.provider_calls", result.providerCalls);
    this.telemetry.incr("extraction.candidates.accepted", result.accepted.length);
    this.telemetry.incr("extraction.candidates.duplicate", result.duplicateCandidates);
    // Rejections never reach this line: ExtractionService throws all-or-nothing,
    // and the worker records the structured details on the job instead.

    // Slice 4 integration: resolve each extracted mention but never rewrite the
    // accepted candidates or the episode. Outcomes are audit data inside the
    // same fence; a `matched` decision only records an explicit alias on the
    // existing entity — no implicit merge, no mutation of statement ids.
    const recordedAt = (this.deps.clock ?? systemClock).now().toISOString();
    const resolutionOutcomes: ResolutionOutcome[] = [];
    if (this.deps.resolver && this.deps.resolutions) {
      for (const write of result.accepted) {
        const mentioned = [
          write.entities.find((e) => e.id === write.statement.subjectId),
          write.statement.objectKind === "entity"
            ? write.entities.find((e) => e.id === write.statement.objectId)
            : undefined,
        ].filter((e): e is NonNullable<typeof e> => e !== undefined);
        for (const entity of mentioned) {
          const decision = await this.deps.resolver.resolve({
            mention: { name: entity.canonicalName, type: entity.type },
            context: episode.text,
            episodeId: episode.id,
          });
          resolutionOutcomes.push({
            id: `resout:${ids.sha256([episode.id, write.statement.id, decision.resolutionId, entity.id].join("|"))}`,
            resolutionId: decision.resolutionId,
            episodeId: episode.id,
            statementId: write.statement.id,
            mentionName: entity.canonicalName,
            mentionType: entity.type,
            outcome: decision.outcome,
            entityId: "entityId" in decision ? decision.entityId : undefined,
            candidates: decision.candidates,
            rationale: decision.rationale,
            recordedAt,
          });
        }
      }
    }

    return {
      summary: `${result.accepted.length} candidate(s) accepted`,
      commit: async (tx) => {
        for (const write of result.accepted) await this.deps.statements.insert(tx, write);
        if (this.deps.resolutions) {
          for (const outcome of resolutionOutcomes) {
            await this.deps.resolutions.putOutcome(tx, outcome);
            if (outcome.outcome === "matched" && outcome.entityId) {
              await this.deps.resolutions.addAlias(tx, outcome.entityId, [outcome.mentionName]);
            }
          }
        }
      },
    };
  }
}

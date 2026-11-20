import type { ManagedTransaction } from "neo4j-driver";
import { z } from "zod";
import { noopTelemetry, type Telemetry } from "../core/telemetry.js";
import { NotFoundError, ValidationError } from "../core/errors.js";
import type { StatementStore } from "../contracts/ports.js";
import type { EpisodeReader } from "../memory/episodeReader.js";
import type { JobHandler, PreparedJob, WorkerJob } from "../jobs/worker.js";
import type { ExtractionService } from "./extractEpisode.js";

const ExtractPayloadSchema = z.object({ episodeId: z.string().min(1) });

export interface ExtractionJobHandlerDeps {
  episodes: EpisodeReader;
  extractor: ExtractionService;
  statements: StatementStore<ManagedTransaction>;
  telemetry?: Telemetry;
}

/** The only job handler shipped in Slice 3: episode -> validated candidates. */
export class ExtractionJobHandler implements JobHandler<ManagedTransaction> {
  readonly kind = "extract";
  private readonly telemetry: Telemetry;

  constructor(private readonly deps: ExtractionJobHandlerDeps) {
    this.telemetry = deps.telemetry ?? noopTelemetry;
  }

  async prepare(job: WorkerJob): Promise<PreparedJob<ManagedTransaction>> {
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
    this.telemetry.incr("extraction.candidates.rejected", result.rejected.length);
    this.telemetry.incr("extraction.candidates.duplicate", result.duplicateCandidates);

    return {
      summary: `${result.accepted.length} accepted, ${result.rejected.length} rejected`,
      commit: async (tx) => {
        for (const write of result.accepted) await this.deps.statements.insert(tx, write);
      },
    };
  }
}

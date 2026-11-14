import type { Driver } from "neo4j-driver";
import { createDriver, neo4jConfigFromEnv, newSession } from "../interfaces/neo4j.js";
import { EpisodeStore, type EpisodePrecision, type EpisodeRole, type EpisodeSource } from "../memory/episodeStore.js";
import { JobLedger } from "../jobs/ledger.js";
import { ids } from "../core/ids.js";
import { migrate } from "../memory/migrate.js";

export interface IngestInput {
  sessionId: string;
  text: string;
  role?: EpisodeRole;
  seq?: number;
  occurredAt?: Date;
  precision?: EpisodePrecision;
  tz?: string;
  source?: EpisodeSource;
}

export interface IngestResult {
  episodeId: string;
  externalId: string;
  created: boolean;
  jobId: string;
}

export class IngestionService {
  constructor(
    private readonly driver: Driver,
    private readonly ledger: JobLedger,
  ) {}

  private static externalId(input: IngestInput, occurredAt: Date): string {
    // Content-addressed identity: same session + role + text + instant ⇒ same episode.
    return ids.sha256([input.sessionId, input.role ?? "user", input.text, occurredAt.toISOString()].join("|"));
  }

  /**
   * Persist episode + outbox job in ONE transaction (ADR-010): crash ⇒ both or neither.
   * Re-delivery of the same message converges to the existing episode (idempotent).
   */
  async ingestMessage(input: IngestInput, userId = "user:local"): Promise<IngestResult> {
    const occurredAt = input.occurredAt ?? new Date();
    const externalId = IngestionService.externalId(input, occurredAt);
    const episodeId = ids.uuid();
    const jobId = ids.uuid();

    const session = newSession(this.driver, "WRITE");
    try {
      return await session.executeWrite(async (tx) => {
        // ensure user exists (single-tenant)
        await tx.run(`MERGE (u:User {id: $id}) ON CREATE SET u.createdAt = datetime(), u.timezone = $tz`, {
          id: userId,
          tz: input.tz ?? "UTC",
        });

        const existing = await tx.run(
          `MATCH (e:Episode {externalId: $externalId}) RETURN e.id AS id`,
          { externalId },
        );
        if (existing.records.length > 0) {
          const id = existing.records[0]!.get("id") as string;
          const job = await tx.run(
            `MATCH (e:Episode {id: $id})-[:PENDING_EXTRACTION]->(j:Job) RETURN j.id AS jobId LIMIT 1`,
            { id },
          );
          return { episodeId: id, externalId, created: false, jobId: job.records[0]?.get("jobId") as string };
        }

        const seq =
          input.seq ??
          ((await tx.run(
            `MATCH (e:Episode {sessionId: $sessionId}) RETURN coalesce(max(e.seq), -1) + 1 AS seq`,
            { sessionId: input.sessionId },
          )).records[0]!.get("seq") as number);

        await tx.run(
          `MATCH (u:User {id: $userId})
           CREATE (e:Episode {
             id: $episodeId, externalId: $externalId, sessionId: $sessionId, seq: $seq,
             role: $role, text: $text, occurredAt: datetime($occurredAt),
             precision: $precision, tz: $tz, source: $source, createdAt: datetime()
           })
           CREATE (u)-[:PARTICIPATED_IN]->(e)`,
          {
            userId,
            episodeId,
            externalId,
            sessionId: input.sessionId,
            seq,
            role: input.role ?? "user",
            text: input.text,
            occurredAt: occurredAt.toISOString(),
            precision: input.precision ?? "second",
            tz: input.tz ?? "UTC",
            source: input.source ?? "chat",
          },
        );

        // outbox — same transaction
        await tx.run(
          `MATCH (e:Episode {id: $episodeId})
           CREATE (j:Job {
             id: $jobId, kind: 'extract', idempotencyKey: $jobKey, payloadJson: $payload,
             status: 'pending', attempts: 0, maxAttempts: $maxAttempts, claimGeneration: 0,
             nextRunAt: datetime(), createdAt: datetime()
           })
           CREATE (e)-[:PENDING_EXTRACTION]->(j)`,
          {
            episodeId,
            jobId,
            jobKey: `extract:${episodeId}`,
            payload: JSON.stringify({ episodeId }),
            maxAttempts: Number(process.env.JOB_MAX_ATTEMPTS ?? 5),
          },
        );

        return { episodeId, externalId, created: true, jobId };
      });
    } finally {
      await session.close();
    }
  }
}

/** Convenience wiring shared by CLI scripts. */
export function buildIngestion() {
  const cfg = neo4jConfigFromEnv();
  const driver = createDriver(cfg);
  const ledger = new JobLedger(driver, {
    leaseSeconds: Number(process.env.JOB_LEASE_SECONDS ?? 120),
    sweepIntervalMs: 30_000,
  });
  return { driver, ledger, episodes: new EpisodeStore(driver), ingestion: new IngestionService(driver, ledger) };
}

export { migrate };

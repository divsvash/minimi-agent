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
  /**
   * Stable upstream message id (preferred dedup key — survives timestamp
   * variance and genuinely identical repeated turns).
   * Identity contract:
   *   messageId   → externalId = sha256("msg|" + sessionId + "|" + messageId)
   *   otherwise   → externalId = sha256("content|" + sessionId + "|" + role + "|" + text + "|" + occurredAtISO)
   * Without messageId, byte-identical re-deliveries are treated as idempotent
   * re-sends of one turn. Genuinely separate, content-identical turns in one
   * session MUST carry a messageId.
   */
  messageId?: string;
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
    // Identity contract (docs/architecture.md §3.2): upstream messageId wins;
    // content-addressing is the deterministic fallback for idempotent redelivery.
    if (input.messageId) {
      return ids.sha256(["msg", input.sessionId, input.messageId].join("|"));
    }
    return ids.sha256(
      ["content", input.sessionId, input.role ?? "user", input.text, occurredAt.toISOString()].join("|"),
    );
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

    const MAX_ATTEMPTS = 5;
    const session = newSession(this.driver, "WRITE");
    try {
      // (sessionId, seq) has a UNIQUE constraint — concurrent ingestions may
      // contend on the same max(seq)+1; the loser retries with a fresh value.
      for (let attempt = 1; ; attempt++) {
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

        // Sequence allocation: per-session sequencer node locked in this
        // transaction — concurrent ingestions serialize on it, so collisions
        // cannot occur. (sessionId, seq) UNIQUE remains as the invariant guard.
        const seqRec = await tx.run(
          `MERGE (g:SeqGuard {sessionId: $sessionId})
             ON CREATE SET g.next = 0
           SET g.next = g.next + 1
           RETURN g.next - 1 AS seq`,
          { sessionId: input.sessionId },
        );
        const seq =
          input.seq ?? (seqRec.records[0]!.get("seq") as number);
        if (input.seq !== undefined) {
          // keep the sequencer ahead of an externally supplied sequence
          await tx.run(
            `MERGE (g:SeqGuard {sessionId: $sessionId})
               ON CREATE SET g.next = $bump
               SET g.next = CASE WHEN g.next < $bump THEN $bump ELSE g.next END`,
            { sessionId: input.sessionId, bump: input.seq + 1 },
          );
        }

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
        } catch (err) {
          const code = String((err as { code?: string })?.code ?? "");
          const msg = String((err as Error)?.message ?? err);
          const seqCollision =
            code === "Neo.ClientError.Schema.ConstraintValidationFailed" ||
            code === "Neo.ClientError.General.ConstraintError" ||
            msg.includes("episode_session_seq");
          if (!seqCollision || attempt >= MAX_ATTEMPTS) throw err;
        }
      }
    } finally {
      await session.close();
    }
  }
}

/** Wire ingestion services onto ONE shared driver (single pool, single shutdown path). */
export function buildIngestion(driver: import("neo4j-driver").Driver) {
  const ledger = new JobLedger(driver, {
    leaseSeconds: Number(process.env.JOB_LEASE_SECONDS ?? 120),
    sweepIntervalMs: 30_000,
  });
  return { ledger, episodes: new EpisodeStore(driver), ingestion: new IngestionService(driver, ledger) };
}

export { migrate };

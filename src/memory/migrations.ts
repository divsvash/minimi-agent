/**
 * Slice 1 migrations. Each entry runs once, in order, recorded in (:SchemaVersion).
 * Constraints and indexes from the architecture (docs/architecture.md §8):
 *  - Episode.externalId unique (idempotent ingest), Episode.id unique
 *  - Job.id unique, Job.idempotencyKey unique
 *  - Job (status, nextRunAt) index for claim scan
 *  - Episode full-text index (synchronous on commit — ADR-011)
 */
export const MIGRATIONS: { id: string; cypher: string[] }[] = [
  {
    id: "0001_constraints_and_fulltext",
    cypher: [
      "CREATE CONSTRAINT episode_id IF NOT EXISTS FOR (e:Episode) REQUIRE e.id IS UNIQUE",
      "CREATE CONSTRAINT episode_external IF NOT EXISTS FOR (e:Episode) REQUIRE e.externalId IS UNIQUE",
      "CREATE CONSTRAINT job_id IF NOT EXISTS FOR (j:Job) REQUIRE j.id IS UNIQUE",
      "CREATE CONSTRAINT job_idempotency IF NOT EXISTS FOR (j:Job) REQUIRE j.idempotencyKey IS UNIQUE",
      "CREATE INDEX job_claim IF NOT EXISTS FOR (j:Job) ON (j.status, j.nextRunAt)",
      "CREATE FULLTEXT INDEX episode_text IF NOT EXISTS FOR (e:Episode) ON EACH [e.text]",
      "CREATE CONSTRAINT user_id IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE",
    ],
  },
  {
    id: "0002_session_sequence_unique",
    cypher: [
      "CREATE CONSTRAINT episode_session_seq IF NOT EXISTS FOR (e:Episode) REQUIRE (e.sessionId, e.seq) IS UNIQUE",
    ],
  },
  {
    id: "0003_statement_provenance",
    cypher: [
      "CREATE CONSTRAINT statement_id IF NOT EXISTS FOR (s:Statement) REQUIRE s.id IS UNIQUE",
      "CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (e:Entity) REQUIRE e.id IS UNIQUE",
      "CREATE CONSTRAINT evidence_id IF NOT EXISTS FOR (e:Evidence) REQUIRE e.id IS UNIQUE",
      "CREATE INDEX statement_subject IF NOT EXISTS FOR (s:Statement) ON (s.subjectId)",
      "CREATE INDEX statement_predicate IF NOT EXISTS FOR (s:Statement) ON (s.predicate)",
      "CREATE INDEX statement_recorded IF NOT EXISTS FOR (s:Statement) ON (s.recordedAt)",
      "CREATE INDEX evidence_episode IF NOT EXISTS FOR (e:Evidence) ON (e.episodeId)",
      "CREATE INDEX entity_canonical IF NOT EXISTS FOR (e:Entity) ON (e.canonicalName)",
    ],
  },
  {
    id: "0004_resolution_audit",
    cypher: [
      "CREATE CONSTRAINT merge_event_id IF NOT EXISTS FOR (e:MergeEvent) REQUIRE e.id IS UNIQUE",
      "CREATE CONSTRAINT split_event_id IF NOT EXISTS FOR (e:SplitEvent) REQUIRE e.id IS UNIQUE",
      "CREATE CONSTRAINT resolution_outcome_id IF NOT EXISTS FOR (o:ResolutionOutcome) REQUIRE o.id IS UNIQUE",
    ],
  },
];

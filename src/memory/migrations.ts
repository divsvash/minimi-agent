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
];

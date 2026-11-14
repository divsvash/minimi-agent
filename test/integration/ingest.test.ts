import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, closeDatabase, type TestContext } from "./helpers.js";
import { newSession } from "../../src/interfaces/neo4j.js";
import { IngestionService } from "../../src/ingestion/ingestMessage.js";
import { JobLedger } from "../../src/jobs/ledger.js";
import { EpisodeStore } from "../../src/memory/episodeStore.js";

let ctx: TestContext;
let ingestion: IngestionService;
let episodes: EpisodeStore;

before(async () => {
  ctx = await freshDatabase();
  ingestion = new IngestionService(ctx.driver, new JobLedger(ctx.driver));
  episodes = new EpisodeStore(ctx.driver);
});

after(async () => {
  await closeDatabase(ctx);
});

test("ingest creates episode + outbox job atomically; re-delivery is idempotent", async () => {
  const input = {
    sessionId: "s1",
    text: "Recommend a Postgres host",
    occurredAt: new Date("2026-11-03T14:22:00Z"),
    tz: "Europe/Lisbon",
  };
  const first = await ingestion.ingestMessage(input);
  assert.equal(first.created, true);

  const second = await ingestion.ingestMessage(input);
  assert.equal(second.created, false);
  assert.equal(second.episodeId, first.episodeId);

  const s = newSession(ctx.driver, "READ");
  const { records } = await s.run(
    `MATCH (e:Episode {id: $id})-[:PENDING_EXTRACTION]->(j:Job {kind: 'extract'}) RETURN j.id AS jobId, j.status AS status`,
    { id: first.episodeId },
  );
  await s.close();
  assert.equal(records.length, 1, "episode must carry exactly one outbox extract job");
  assert.equal(records[0]!.get("status"), "pending");
});

test("verbatim day-scoped recall (2026-11-03, Europe/Lisbon) returns the turn", async () => {
  await ingestion.ingestMessage({
    sessionId: "s2", text: "What did I ask on 3 November?",
    occurredAt: new Date("2026-11-03T09:00:00Z"), tz: "Europe/Lisbon",
  });
  const s = newSession(ctx.driver, "READ");
  const dayFrom = "2026-11-03T00:00:00Z", dayTo = "2026-11-04T00:00:00Z";
  const { records } = await s.run(
    "MATCH (e:Episode) WHERE e.occurredAt >= datetime($from) AND e.occurredAt < datetime($to) AND e.role = 'user' RETURN e.text AS t ORDER BY e.occurredAt",
    { from: dayFrom, to: dayTo },
  );
  await s.close();
  assert.ok(records.some((r) => String(r.get("t")).includes("3 November")));
});

test("full-text index sees committed episode synchronously (no wait)", async () => {
  await ingestion.ingestMessage({
    sessionId: "s3", text: "shortlist HubSpot, Pipedrive, Salesforce, Close, Attio",
    occurredAt: new Date(),
  });
  const hits = await episodes.search("HubSpot");
  assert.ok(hits.length >= 1, "full-text must find the episode immediately after commit");
});

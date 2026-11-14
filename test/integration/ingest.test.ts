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

test("concurrent ingestions on one session — (sessionId, seq) is unique and collision-free", async () => {
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      ingestion.ingestMessage({
        sessionId: "s-concurrent",
        text: `turn-${i}`,
        occurredAt: new Date(`2026-11-03T10:00:0${i}Z`),
      }),
    ),
  );
  assert.equal(results.filter((r) => r.created).length >= 1, true);
  const s = newSession(ctx.driver, "READ");
  const seqs = await s.run(
    "MATCH (e:Episode {sessionId: 's-concurrent'}) RETURN e.seq AS seq ORDER BY e.seq",
  );
  await s.close();
  const seen = seqs.records.map((r) => Number(r.get("seq")));
  assert.equal(new Set(seen).size, seen.length, "seq values must be unique per session");
});

test("upstream messageId is preferred dedup key — same message, different timestamps, one episode", async () => {
  const a = await ingestion.ingestMessage({
    sessionId: "s4", messageId: "client-msg-001", text: "identical hello",
    occurredAt: new Date("2026-11-03T09:00:00Z"),
  });
  const b = await ingestion.ingestMessage({
    sessionId: "s4", messageId: "client-msg-001", text: "identical hello",
    occurredAt: new Date("2026-11-03T09:00:01Z"), // different instant, same client message id
  });
  assert.equal(a.episodeId, b.episodeId);

  // content-addressed fallback: byte-identical resend, same instant → same episode
  const c = await ingestion.ingestMessage({
    sessionId: "s5", text: "identical hello",
    occurredAt: new Date("2026-11-03T09:00:00Z"),
  });
  const d = await ingestion.ingestMessage({
    sessionId: "s5", text: "identical hello",
    occurredAt: new Date("2026-11-03T09:00:00Z"),
  });
  assert.equal(c.episodeId, d.episodeId);
});

test("full-text index sees committed episode synchronously (no wait)", async () => {
  await ingestion.ingestMessage({
    sessionId: "s3", text: "shortlist HubSpot, Pipedrive, Salesforce, Close, Attio",
    occurredAt: new Date(),
  });
  const hits = await episodes.search("HubSpot");
  assert.ok(hits.length >= 1, "full-text must find the episode immediately after commit");
});

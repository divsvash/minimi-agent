import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, closeDatabase, type TestContext } from "./helpers.js";
import { newSession } from "../../src/interfaces/neo4j.js";
import { EpisodeStore } from "../../src/memory/episodeStore.js";

let ctx: TestContext;
let episodes: EpisodeStore;

before(async () => {
  ctx = await freshDatabase();
  episodes = new EpisodeStore(ctx.driver);
  const s = newSession(ctx.driver, "WRITE");
  await s.run(
    `CREATE (e:Episode {
       id: 'ep-invalid-range', externalId: 'x-invalid-range', sessionId: 's1', seq: 0,
       role: 'user', text: 'hello range', occurredAt: datetime('2026-11-03T10:00:00.000Z'),
       precision: 'second', tz: 'UTC', source: 'chat', createdAt: datetime('2026-11-03T10:00:00.000Z')
     })`,
  );
  await s.close();
});

after(async () => {
  await closeDatabase(ctx);
});

test("Neo4j EpisodeStore: invalid range (from >= to) returns an empty result, never throws", async () => {
  const iso = (d: string) => new Date(d);
  assert.deepEqual(
    (await episodes.byOccurredRange(iso("2026-11-04T00:00:00.000Z"), iso("2026-11-03T00:00:00.000Z"))).map((e) => e.id),
    [],
    "from > to must match nothing",
  );
  const same = iso("2026-11-03T00:00:00.000Z");
  assert.deepEqual((await episodes.byOccurredRange(same, same)).map((e) => e.id), [], "from == to must match nothing");

  // sanity: the same episode inside a valid range is found
  const found = await episodes.byOccurredRange(iso("2026-11-03T00:00:00.000Z"), iso("2026-11-04T00:00:00.000Z"));
  assert.ok(found.some((e) => e.id === "ep-invalid-range"));
});

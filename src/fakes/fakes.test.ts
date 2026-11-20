import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeClock } from "./fakeClock.js";
import { DeterministicIdGenerator } from "./deterministicIdGenerator.js";
import { FakeLLMProvider, FakeEmbeddingProvider, FAKE_LLM_PRICE } from "./providers.js";
import { FakeResearchProvider, researchFixtures } from "./research.js";
import { ProviderTimeoutError, ProviderUnavailableError, ProviderError } from "../core/errors.js";

test("FakeClock only moves when told to", () => {
  const c = new FakeClock(new Date("2026-11-19T00:00:00.000Z"));
  assert.equal(c.now().toISOString(), "2026-11-19T00:00:00.000Z");
  c.advanceHours(3);
  assert.equal(c.now().toISOString(), "2026-11-19T03:00:00.000Z");
  c.set(new Date("2027-01-01T00:00:00.000Z"));
  assert.equal(c.now().toISOString(), "2027-01-01T00:00:00.000Z");
});

test("DeterministicIdGenerator issues stable sequential ids", () => {
  const g = new DeterministicIdGenerator({ prefix: "test" });
  assert.deepEqual([g.uuid(), g.uuid(), g.uuid()], ["test-000001", "test-000002", "test-000003"]);
});

test("FakeLLMProvider scripts responses, records usage, computes pinned cost", async () => {
  const llm = new FakeLLMProvider(() => ({
    text: "answer",
    model: FAKE_LLM_PRICE.model,
    usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
  }));
  const res = await llm.complete({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.text, "answer");
  const expected = FAKE_LLM_PRICE.inputPerMTok + FAKE_LLM_PRICE.outputPerMTok;
  assert.ok(Math.abs(llm.costUsd() - expected) < 1e-12);
  assert.equal(llm.callCount, 1);
});

test("FakeLLMProvider failure injection: error, timeout, unavailable", async () => {
  const llm = new FakeLLMProvider();
  llm.failNext(1).timeoutNext(1).unavailableNext(1);
  await assert.rejects(llm.complete({ messages: [{ role: "user", content: "a" }] }), ProviderTimeoutError);
  await assert.rejects(llm.complete({ messages: [{ role: "user", content: "b" }] }), ProviderUnavailableError);
  await assert.rejects(llm.complete({ messages: [{ role: "user", content: "c" }] }), ProviderError);
  const ok = await llm.complete({ messages: [{ role: "user", content: "d" }] });
  assert.ok(ok.text.startsWith("fake-llm-response"));
});

test("FakeLLMProvider conflicting responses are scriptable by prompt content", async () => {
  const llm = new FakeLLMProvider((req) => ({
    text: req.messages.at(-1)!.content.includes("pricing") ? "$49/month" : "no idea",
    model: FAKE_LLM_PRICE.model,
    usage: { inputTokens: 10, outputTokens: 4 },
  }));
  const a = await llm.complete({ messages: [{ role: "user", content: "acme pricing?" }] });
  const b = await llm.complete({ messages: [{ role: "user", content: "favorite color?" }] });
  assert.equal(a.text, "$49/month");
  assert.equal(b.text, "no idea");
});

test("FakeLLMProvider queued responses are consumed FIFO", async () => {
  const llm = new FakeLLMProvider();
  llm.enqueue(
    { text: "first", model: FAKE_LLM_PRICE.model, usage: { inputTokens: 1, outputTokens: 1 } },
    { text: "second", model: FAKE_LLM_PRICE.model, usage: { inputTokens: 1, outputTokens: 1 } },
  );
  const a = await llm.complete({ messages: [{ role: "user", content: "q" }] });
  const b = await llm.complete({ messages: [{ role: "user", content: "q" }] });
  assert.equal(a.text, "first");
  assert.equal(b.text, "second");
});

test("FakeEmbeddingProvider is stable, dimension-sized, and uses non-overlapping digest bytes", async () => {
  const e = new FakeEmbeddingProvider("fake-embed-1", 16);
  const [v1] = await e.embed(["hello world"]);
  const [v2] = await e.embed(["hello world"]);
  assert.equal(v1!.length, 16);
  assert.deepEqual(v1, v2);
  assert.notDeepEqual(
    v1!.slice(0, 8),
    v1!.slice(8, 16),
    "default 16-d vector must not repeat the first half",
  );
  for (const x of v1!) assert.ok(x >= -1 && x <= 1, `embedding component out of range: ${x}`);

  const batch = await e.embed(["alpha", "beta"]);
  assert.notDeepEqual(batch[0], batch[1], "different texts should not produce identical vectors");
  assert.deepEqual(await e.embed(["alpha", "beta"]), batch, "batch vectors should be stable");
  assert.deepEqual(
    (await new FakeEmbeddingProvider("fake-embed-1", 16).embed(["hello world"]))[0],
    v1,
    "vectors should be deterministic across provider instances",
  );

  const [long] = await new FakeEmbeddingProvider("fake-embed-1", 40).embed(["hello world"]);
  assert.equal(long!.length, 40, "vectors longer than one digest block should keep growing");
  assert.notDeepEqual(
    long!.slice(0, 8),
    long!.slice(32, 40),
    "a later digest block must not repeat the first block",
  );

  e.timeoutNext(1);
  await assert.rejects(e.embed(["x"]), ProviderTimeoutError);
});

test("FakeResearchProvider scripts the verdict matrix deterministically", async () => {
  const r = new FakeResearchProvider({ now: () => new Date("2026-11-19T00:00:00.000Z") });
  r.enqueue(researchFixtures.verifiedUnchanged("$49/month", "https://acme.example/pricing"));
  r.enqueue(researchFixtures.changed("$49/month", "$59/month", "https://acme.example/pricing"));
  r.enqueue(researchFixtures.emptyResults());
  r.enqueue(researchFixtures.staleSource("2026-06-01T00:00:00.000Z", "https://acme.example/pricing"));
  r.enqueue(researchFixtures.conflictingSources("https://a.example", "https://b.example"));
  r.enqueue(researchFixtures.dimensionMismatch("https://acme.example/annual-plan"));

  const req = { entity: { name: "Acme CRM" }, attribute: "pricing.amount", dimensions: { plan: "team", billingPeriod: "monthly" } };
  const unchanged = await r.observe(req);
  const changed = await r.observe(req);
  assert.equal(unchanged.verdict, "verified_unchanged");
  assert.equal(changed.verdict, "changed");
  assert.equal((await r.observe(req)).verdict, "insufficient_evidence");
  const stale = await r.observe(req);
  assert.equal(stale.verdict, "no_change_found");
  assert.equal(stale.reason, "stale_source");
  const conflict = await r.observe(req);
  assert.equal(conflict.verdict, "no_change_found");
  assert.equal(conflict.reason, "conflicting_unresolved");
  assert.equal(conflict.run.attempts.length, 2);
  const mismatch = await r.observe(req);
  assert.equal(mismatch.reason, "dimension_mismatch");
  assert.equal(r.calls.length, 6);
});

test("changed/verifiedUnchanged fixtures carry coherent baseline and current observations", () => {
  const changed = researchFixtures.changed("$49/month", "$59/month", "https://acme.example/pricing").outcome;
  assert.ok(changed.baseline);
  assert.ok(changed.current);
  assert.notEqual(changed.baseline.id, changed.current.id);
  assert.notEqual(changed.baseline.value, changed.current.value);
  assert.deepEqual(changed.baseline.dimensions, changed.current.dimensions);
  assert.equal(changed.current.value, "$59/month");
  assert.equal(changed.attempts[0]!.value, changed.current.value);

  const unchanged = researchFixtures.verifiedUnchanged("$49/month", "https://acme.example/pricing").outcome;
  assert.ok(unchanged.baseline);
  assert.ok(unchanged.current);
  assert.notEqual(unchanged.baseline.id, unchanged.current.id);
  assert.equal(unchanged.baseline.value, unchanged.current.value);
  assert.deepEqual(unchanged.baseline.dimensions, unchanged.current.dimensions);
  assert.equal(unchanged.attempts[0]!.value, unchanged.current.value);

  assert.throws(
    () => researchFixtures.changed("$49/month", "$49/month", "https://acme.example/pricing"),
    /distinct baseline\/current values/,
  );
});

test("InMemoryEpisodeStore semantics match the Slice 1 contract (verbatim, ordered, half-open)", async () => {
  const { InMemoryEpisodeStore } = await import("./memoryEpisodeStore.js");
  const s = new InMemoryEpisodeStore();
  const mk = (id: string, seq: number, occurredAt: string, text: string) => ({
    id, externalId: `x-${id}`, sessionId: "s", seq, role: "user" as const, text,
    occurredAt, precision: "second" as const, tz: "UTC", source: "chat" as const, createdAt: occurredAt,
  });
  s.seed([
    mk("b", 1, "2026-11-03T10:00:00.000Z", "second"),
    mk("a", 0, "2026-11-03T09:00:00.000Z", "first"),
    mk("edge-before", 2, "2026-11-02T23:59:59.000Z", "before"),
    mk("edge-after", 3, "2026-11-04T00:00:00.000Z", "after"),
  ]);
  const items = await s.byOccurredRange(new Date("2026-11-03T00:00:00.000Z"), new Date("2026-11-04T00:00:00.000Z"));
  assert.deepEqual(items.map((e) => e.id), ["a", "b"]);
  assert.equal(items[0]!.text, "first");
});

test("InMemoryEpisodeStore: invalid range (from >= to) returns empty, never throws", async () => {
  const { InMemoryEpisodeStore } = await import("./memoryEpisodeStore.js");
  const s = new InMemoryEpisodeStore();
  const mk = (id: string, seq: number, occurredAt: string) => ({
    id, externalId: `x-${id}`, sessionId: "s", seq, role: "user" as const, text: id,
    occurredAt, precision: "second" as const, tz: "UTC", source: "chat" as const, createdAt: occurredAt,
  });
  s.seed([mk("a", 0, "2026-11-03T09:00:00.000Z")]);
  const same = new Date("2026-11-03T00:00:00.000Z");
  assert.deepEqual(await s.byOccurredRange(same, same), []);
  assert.deepEqual(await s.byOccurredRange(new Date("2026-11-04T00:00:00.000Z"), new Date("2026-11-03T00:00:00.000Z")), []);
});

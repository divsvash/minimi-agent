import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ProviderError, ProviderTimeoutError, ValidationError,
} from "../core/errors.js";
import { fixedClock } from "../core/clock.js";
import type { Episode } from "../contracts/schemas.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../contracts/ports.js";
import { FakeLLMProvider } from "../fakes/providers.js";
import { EXTRACTION_PROMPT_VERSION } from "./prompt.js";
import { EXTRACTION_SCHEMA_VERSION } from "./validate.js";
import { ExtractionService, parseExtractionResponse } from "./extractEpisode.js";

const TEXT = "We should use Postgres for the new service.";

const episode = (over: Partial<Episode> = {}): Episode => ({
  id: "ep-1",
  externalId: "ext-1",
  sessionId: "sess-1",
  seq: 0,
  role: "user",
  text: TEXT,
  occurredAt: "2026-11-16T09:00:00.000Z",
  precision: "second",
  tz: "Europe/Lisbon",
  source: "chat",
  createdAt: "2026-11-16T09:00:00.000Z",
  ...over,
});

const goodCandidate = {
  subject: { name: "We" },
  predicate: "should use",
  object: { kind: "entity", name: "Postgres", type: "product" },
  polarity: "positive",
  modality: "proposed",
  decisionStatus: "proposed",
  confidence: 0.8,
  evidence: { quote: TEXT, spanStart: 0, spanEnd: 43 },
};

const response = (...candidates: unknown[]): string =>
  JSON.stringify({ candidates });

const service = (provider: LLMProvider, over: { maxProviderAttempts?: number; timeoutMs?: number } = {}) =>
  new ExtractionService({
    provider,
    timeoutMs: over.timeoutMs ?? 0, // no local deadline unless a test asks for one
    maxProviderAttempts: over.maxProviderAttempts ?? 2,
    clock: fixedClock(new Date("2026-11-19T00:00:00.000Z")),
  });

test("a retryable provider timeout is retried inside the same extraction", async () => {
  const provider = new FakeLLMProvider(() => ({
    text: response(goodCandidate),
    model: "fake-llm-1",
    usage: { inputTokens: 100, outputTokens: 50 },
    finishReason: "stop",
  }));
  provider.timeoutNext(1);

  const result = await service(provider).extractEpisode(episode());
  assert.equal(result.providerCalls, 2, "one timeout + one success");
  assert.equal(provider.callCount, 2);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rejected.length, 0);
});

test("provider attempts are bounded by maxProviderAttempts", async () => {
  const provider = new FakeLLMProvider();
  provider.timeoutNext(10);
  await assert.rejects(
    () => service(provider, { maxProviderAttempts: 3 }).extractEpisode(episode()),
    (err: unknown) => err instanceof ProviderTimeoutError,
  );
  assert.equal(provider.callCount, 3, "no unbounded retry loop");
});

test("a non-retryable provider failure is not retried", async () => {
  let calls = 0;
  const provider: LLMProvider = {
    complete: async (): Promise<LLMResponse> => {
      calls += 1;
      throw new ProviderError("permanent refusal", false);
    },
  };
  await assert.rejects(
    () => service(provider, { maxProviderAttempts: 4 }).extractEpisode(episode()),
    (err: unknown) => err instanceof ProviderError && err.message === "permanent refusal",
  );
  assert.equal(calls, 1, "non-retryable failures must fail fast");
});

test("the local deadline turns a hung provider into ProviderTimeoutError", async () => {
  const provider: LLMProvider = {
    complete: () => new Promise<LLMResponse>(() => { /* never settles */ }),
  };
  await assert.rejects(
    () => service(provider, { timeoutMs: 5 }).extractEpisode(episode()),
    (err: unknown) =>
      err instanceof ProviderTimeoutError && err.message.includes("timed out after 5ms"),
  );
});

test("malformed and schema-invalid responses are rejected with structured detail", () => {
  assert.throws(
    () => parseExtractionResponse("not json at all"),
    (err: unknown) =>
      err instanceof ValidationError
      && err.message.includes("extraction response is not valid JSON")
      && typeof err.issues === "object",
  );
  assert.throws(
    () => parseExtractionResponse(JSON.stringify({ candidates: [{ modality: "definitely-not-a-modality" }] })),
    (err: unknown) =>
      err instanceof ValidationError
      && err.message.includes("extraction response failed schema validation")
      && Array.isArray(err.issues),
  );
  // A markdown fence is tolerated, because models do that; nothing else is.
  const fenced = parseExtractionResponse(`\`\`\`json\n${response(goodCandidate)}\n\`\`\``);
  assert.equal(fenced.candidates.length, 1);
});

test("all-or-nothing: one bad candidate fails the episode and names every reason", async () => {
  const bad = { ...goodCandidate, subject: { name: "MongoDB" } };
  const provider = new FakeLLMProvider(() => ({
    text: response(goodCandidate, bad),
    model: "fake-llm-1",
    usage: { inputTokens: 100, outputTokens: 50 },
    finishReason: "stop",
  }));

  await assert.rejects(
    () => service(provider).extractEpisode(episode()),
    (err: unknown) => {
      assert.ok(err instanceof ValidationError);
      assert.ok(err.message.includes("extraction rejected: 1 of 2 candidate(s) failed validation"));
      assert.ok(err.message.includes("no statements will be persisted"), "the job error must say nothing was written");
      assert.ok(err.message.includes("does not appear in the source episode"));
      const issues = err.issues as { index: number; errors: string[] }[];
      assert.equal(issues.length, 1);
      assert.equal(issues[0]!.index, 1, "the failing candidate's position is preserved");
      assert.ok(issues[0]!.errors.length > 0);
      return true;
    },
  );
});

test("re-extracting under the same version yields byte-identical statement ids", async () => {
  const make = () => new FakeLLMProvider(() => ({
    text: response(goodCandidate),
    model: "fake-llm-1",
    usage: { inputTokens: 10, outputTokens: 5 },
    finishReason: "stop",
  }));

  const first = await service(make()).extractEpisode(episode());
  const second = await service(make()).extractEpisode(episode());

  assert.deepEqual(
    first.accepted.map((w) => w.statement.id),
    second.accepted.map((w) => w.statement.id),
    "an idempotent re-run must not mint new ids",
  );
  assert.deepEqual(
    first.accepted.map((w) => w.evidence[0]!.id),
    second.accepted.map((w) => w.evidence[0]!.id),
  );
  assert.equal(first.extractionVersion, second.extractionVersion);
});

test("a changed model id changes statement ids (version-aware persistence)", async () => {
  const make = (model: string) => new FakeLLMProvider(
    () => ({
      text: response(goodCandidate),
      model,
      usage: { inputTokens: 10, outputTokens: 5 },
      finishReason: "stop",
    }),
    model,
  );

  const a = await service(make("model-a")).extractEpisode(episode());
  const b = await service(make("model-b")).extractEpisode(episode());

  assert.equal(a.extractionModel, "model-a");
  assert.equal(b.extractionModel, "model-b");
  assert.notEqual(a.extractionVersion, b.extractionVersion);
  assert.notEqual(a.accepted[0]!.statement.id, b.accepted[0]!.statement.id);
  // The recorded provenance still points at the prompt/schema contract in force.
  assert.ok(a.extractionVersion.includes(EXTRACTION_PROMPT_VERSION));
  assert.ok(a.extractionVersion.includes(EXTRACTION_SCHEMA_VERSION));
  assert.equal(a.accepted[0]!.statement.extractionModel, "model-a");
});

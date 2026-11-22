import { test } from "node:test";
import assert from "node:assert/strict";
import type { Episode } from "../contracts/schemas.js";
import { ScoreCollector } from "./scores.js";
import { UsageCollector } from "./usage.js";
import { extractionEpisodeHandler } from "./extractionSut.js";

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

const candidate = {
  subject: { name: "We" },
  predicate: "should use",
  object: { kind: "entity", name: "Postgres", type: "product" },
  polarity: "positive",
  modality: "proposed",
  decisionStatus: "proposed",
  confidence: 0.8,
  evidence: { quote: TEXT, spanStart: 0, spanEnd: 43 },
};

const label = {
  subject: "We",
  predicate: "should use",
  object: "Postgres",
  polarity: "positive",
  modality: "proposed",
  decisionStatus: "proposed",
};

const baseInput = (over: Record<string, unknown> = {}) => ({
  episode: episode(),
  responses: [JSON.stringify({ candidates: [candidate] })],
  labels: [label],
  ...over,
});

type Out = Awaited<ReturnType<typeof extractionEpisodeHandler>> & Record<string, any>;

const runSut = async (input: Record<string, unknown>) => {
  const usage = new UsageCollector();
  const scores = new ScoreCollector();
  const out = (await extractionEpisodeHandler(input, usage, scores)) as Out;
  return { out, usage, scores };
};

test("the extraction SUT runs the real pipeline and carries honesty labels", async () => {
  const { out, usage, scores } = await runSut(baseInput());

  assert.equal(out.status, "ok");
  assert.equal(out.provider, "fake-llm-1", "the provider must be named, never implied real");
  assert.equal(out.semanticQuality, "not_measured", "a mocked script cannot certify meaning");
  assert.equal(out.error, null);
  assert.deepEqual(out.outcomes, ["completed"]);

  assert.equal(out.counts.statements, 1);
  assert.equal(out.counts.evidence, 1);
  assert.equal(out.counts.entities, 2);
  assert.equal(out.counts.accepted, 1);
  assert.equal(out.statements[0].modality, "proposed");
  assert.equal(out.statements[0].predicateQualifier.decisionStatus, "proposed");
  assert.equal(out.statements[0].evidence[0].exact, true);
  assert.equal(out.evidence[0].episodeId, "ep-1");

  assert.deepEqual(
    scores.all().map((s) => s.name).sort(),
    ["extraction_precision", "extraction_recall", "negation_modality_preservation", "provenance_validity"].sort(),
    "exactly the applicable scores are recorded",
  );
  assert.equal(
    scores.all().some((s) => s.name === "unsupported_assertion_rate"),
    false,
    "a proposal is not a commitment, so no unsupported-assertion denominator exists",
  );
  assert.equal(
    scores.all().some((s) => s.name === "duplicate_on_retry_rate"),
    false,
    "one run cannot measure retry duplication",
  );
  assert.equal(usage.breakdown().length, 1, "one successful provider call was paid for");
  assert.ok(usage.totalUsd() > 0);
});

test("scores with no real denominator are reported as null, never as a measured 0 or 1", async () => {
  const { out, scores } = await runSut(baseInput({ responses: [JSON.stringify({ candidates: [] })], labels: [] }));

  assert.equal(out.counts.statements, 0);
  assert.equal(out.scores.precision, 1, "an empty result against no labels is a correct empty result");
  assert.equal(out.scores.recall, 1);
  assert.equal(out.scores.provenanceValidity, null, "nothing persisted ⇒ no provenance claim");
  assert.equal(out.scores.negationModalityPreservation, null, "no negative/qualified label ⇒ not measured");
  assert.equal(out.scores.unsupportedAssertionRate, null, "no committing statement ⇒ not measured");
  assert.equal(out.scores.duplicateOnRetryRate, null, "only one run ⇒ retry duplication not measured");
  assert.equal(scores.all().some((s) => s.name === "duplicate_on_retry_rate"), false);
});

test("a second run over the same episode measures duplicate-on-retry as zero", async () => {
  const { out, scores } = await runSut(baseInput({ runs: 2 }));

  assert.deepEqual(out.outcomes, ["completed", "completed"]);
  assert.equal(out.counts.statements, 1, "the second claim must be a no-op");
  assert.equal(out.counts.evidence, 1);
  assert.equal(out.scores.duplicateOnRetryRate, 0);
  assert.equal(
    scores.all().filter((s) => s.name === "duplicate_on_retry_rate").length,
    1,
    "recorded exactly once, for the run that actually measured it",
  );
});

test("a lost fence persists nothing and produces no scores", async () => {
  const { out, scores } = await runSut(baseInput({ staleFence: true }));

  assert.equal(out.status, "fenced_out");
  assert.equal(out.error, null, "a lost fence is not a job failure");
  assert.equal(out.counts.statements, 0);
  assert.equal(out.counts.evidence, 0);
  assert.equal(out.counts.entities, 0);
  assert.equal(out.statements.length, 0);
  assert.deepEqual(scores.all(), [], "a run that never completed is not scored");
  assert.equal(out.scores.precision, null);
});

test("a validation failure surfaces the structured reason on the job error", async () => {
  const bad = { ...candidate, evidence: { quote: "We should use Postgres", spanStart: 0, spanEnd: 43 } };
  const { out, scores } = await runSut(baseInput({ responses: [JSON.stringify({ candidates: [bad] })] }));

  assert.equal(out.status, "failed");
  assert.equal(out.counts.statements, 0, "all-or-nothing: no partial commit");
  assert.equal(out.counts.evidence, 0);
  assert.ok(out.error.includes("no statements will be persisted"));
  assert.ok(out.error.includes("evidence quote does not exactly match the source span"));
  assert.deepEqual(scores.all(), [], "a failed run is not scored");
  assert.equal(out.scores.precision, null);
});

test("a scripted provider timeout is retried inside one job attempt", async () => {
  const { out } = await runSut(baseInput({ providerFailures: { timeout: 1, unavailable: 0, error: 0 }, maxProviderAttempts: 2 }));

  assert.equal(out.status, "ok");
  assert.equal(out.counts.providerCalls, 2, "one timeout + one success");
  assert.equal(out.counts.statements, 1);
});

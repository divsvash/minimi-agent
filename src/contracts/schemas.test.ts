import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EpisodeSchema, StatementSchema, EntitySchema, ObservationSchema,
  EvidenceSchema, CaptureSchema, JobSchema,
} from "./schemas.js";

const validStatement = {
  id: "st-1",
  subjectId: "ent-1",
  predicate: "shortlisted",
  objectKind: "entity",
  objectId: "ent-2",
  polarity: "positive",
  modality: "shortlisted",
  assertedBy: "user",
  epistemicStatus: "user_asserted",
  confidence: 0.9,
  validFrom: "2026-11-03T00:00:00.000Z",
  validTo: null,
  timePrecision: "day",
  validity: "open_ended",
  recordedAt: "2026-11-03T00:00:00.000Z",
  status: "active",
} as const;

test("EpisodeSchema validates a slice-1-shaped episode", () => {
  const e = EpisodeSchema.parse({
    id: "e1", externalId: "x", sessionId: "s", seq: 0, role: "user", text: "hi",
    occurredAt: "2026-11-03T10:00:00.000Z", precision: "second", tz: "Europe/Lisbon",
    source: "chat", createdAt: "2026-11-03T10:00:00.000Z",
  });
  assert.equal(e.seq, 0);
});

test("StatementSchema enforces objectKind/objectId coherence", () => {
  const { objectId: _omit, ...missing } = validStatement;
  assert.equal(StatementSchema.safeParse({ ...validStatement, objectId: undefined }).success, false);
  assert.equal(StatementSchema.safeParse({ ...missing, objectKind: "literal", objectValue: "20-person" }).success, true);
  assert.equal(StatementSchema.safeParse({ ...validStatement, objectKind: "literal" }).success, false);
});

test("StatementSchema rejects validTo < validFrom and invalid confidence", () => {
  assert.equal(
    StatementSchema.safeParse({ ...validStatement, validFrom: "2026-11-03T00:00:00.000Z", validTo: "2026-11-01T00:00:00.000Z" }).success,
    false,
  );
  assert.equal(StatementSchema.safeParse({ ...validStatement, confidence: 1.5 }).success, false);
});

test("StatementSchema: validFrom null = unknown start (never epoch), open intervals valid", () => {
  const parsed = StatementSchema.parse({ ...validStatement, validFrom: null });
  assert.equal(parsed.validFrom, null);
  assert.equal(parsed.validTo, null);
});

test("EntitySchema + EvidenceSchema + CaptureSchema + ObservationSchema validate", () => {
  assert.equal(EntitySchema.safeParse({
    id: "ent-1", type: "product", canonicalName: "HubSpot", aliases: ["hubspot"],
    status: "active", createdAt: "2026-11-03T00:00:00.000Z", updatedAt: "2026-11-03T00:00:00.000Z",
  }).success, true);

  assert.equal(EvidenceSchema.safeParse({
    id: "ev-1", kind: "episode_span", episodeId: "e1", spanStart: 0, spanEnd: 10, quote: "hello",
  }).success, true);
  assert.equal(EvidenceSchema.safeParse({ id: "ev-2", kind: "episode_span" }).success, false, "episode_span requires episodeId");
  assert.equal(EvidenceSchema.safeParse({ id: "ev-3", kind: "external_url", url: "https://example.com" }).success, true);
  assert.equal(EvidenceSchema.safeParse({ id: "ev-4", kind: "episode_span", episodeId: "e1", spanStart: 5, spanEnd: 2 }).success, false);

  assert.equal(CaptureSchema.safeParse({
    id: "cap-1", fetchedAt: "2026-11-19T00:00:00.000Z", sourceUrl: "https://example.com/pricing",
    outcome: "ok", bodyHash: "abc123", jobId: "job-1",
  }).success, true);
  assert.equal(CaptureSchema.safeParse({
    id: "cap-2", fetchedAt: "2026-11-19T00:00:00.000Z", sourceUrl: "https://example.com/pricing",
    outcome: "ok", jobId: "job-1",
  }).success, false, "outcome=ok requires bodyHash");

  assert.equal(ObservationSchema.safeParse({
    id: "obs-1", obsKey: "deadbeef", attribute: "pricing.amount", dimensions: { plan: "team", billingPeriod: "monthly" },
    value: "49.00", sourceEffectiveAt: "2026-11-01T00:00:00.000Z", sourcePublishedAt: null,
    recordedAt: "2026-11-19T00:00:00.000Z",
    source: { url: "https://acme.example/pricing", title: "Pricing", publisher: "Acme", accessedAt: "2026-11-19T00:00:00.000Z" },
    extractionMethod: "selector", extractionConfidence: 0.95, obsNormVersion: 1,
  }).success, true);
});

test("JobSchema validates the fencing token shape", () => {
  const j = JobSchema.parse({
    id: "job-1", kind: "extract", idempotencyKey: "extract:e1", payloadJson: "{}",
    status: "running", attempts: 1, maxAttempts: 5, claimGeneration: 3,
    workerId: "w1", leaseUntil: "2026-11-19T00:10:00.000Z", nextRunAt: null, lastError: null,
  });
  assert.equal(j.claimGeneration, 3);
  assert.equal(JobSchema.safeParse({ ...j, status: "limbo" }).success, false);
});

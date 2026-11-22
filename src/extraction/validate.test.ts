import { test } from "node:test";
import assert from "node:assert/strict";
import type { CandidateStatement, Episode } from "../contracts/schemas.js";
import {
  EXTRACTION_SCHEMA_VERSION, normalizeMention, normalizePredicate, validateCandidates,
} from "./validate.js";

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

const candidate = (over: Partial<CandidateStatement> = {}): CandidateStatement => ({
  subject: { name: "We" },
  predicate: "should use",
  object: { kind: "entity", name: "Postgres", type: "product" },
  polarity: "positive",
  modality: "proposed",
  confidence: 0.8,
  evidence: { quote: TEXT, spanStart: 0, spanEnd: 43 },
  ...over,
});

const run = (candidates: CandidateStatement[], ep: Episode = episode()) =>
  validateCandidates({
    episode: ep,
    candidates,
    extractionModel: "test-model",
    extractionPromptHash: "prompt-hash",
    extractionVersion: "extract/1",
    recordedAt: "2026-11-19T00:00:00.000Z",
  });

/** Assert the candidate is rejected and return its structured reasons. */
const errorsFor = (c: CandidateStatement, ep: Episode = episode()): string[] => {
  const r = run([c], ep);
  assert.equal(r.accepted.length, 0, "expected the candidate to be rejected");
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0]!.index, 0);
  return r.rejected[0]!.errors;
};

const has = (errors: string[], needle: string): void => {
  assert.ok(errors.some((e) => e.includes(needle)), `expected an error containing '${needle}', got ${JSON.stringify(errors)}`);
};

test("a valid candidate maps to exact-span evidence and episode-scoped mention entities", () => {
  const r = run([candidate()]);
  assert.equal(r.rejected.length, 0);
  assert.equal(r.accepted.length, 1);
  assert.equal(r.acceptedCandidates.length, 1);
  assert.equal(r.duplicateCandidates, 0);

  const w = r.accepted[0]!;
  const ev = w.evidence[0]!;
  assert.equal(episode().text.slice(ev.spanStart, ev.spanEnd), ev.quote, "span must be exact");
  assert.equal(ev.kind, "episode_span");
  assert.equal(ev.episodeId, "ep-1");

  assert.ok(w.statement.id.startsWith("stmt:"), "statement ids are content-hashed and namespaced");
  assert.ok(w.entities.every((e) => e.id.startsWith("ent:")), "entity ids are namespaced");
  assert.ok(w.entities.some((e) => e.id === w.statement.subjectId), "subject entity must be written with the statement");
  assert.ok(
    w.entities.some((e) => e.id === w.statement.objectId),
    "object entity must be written with the statement",
  );

  // Provenance/version metadata travels with the statement, not beside it.
  assert.equal(w.statement.extractionModel, "test-model");
  assert.equal(w.statement.extractionPromptHash, "prompt-hash");
  assert.equal(w.statement.predicateQualifier!.extractionStatus, "accepted");
  assert.equal(w.statement.predicateQualifier!.extractionSchema, EXTRACTION_SCHEMA_VERSION);
  // Role-derived epistemic status is derived from the episode, never invented.
  assert.equal(w.statement.assertedBy, "user");
  assert.equal(w.statement.epistemicStatus, "user_asserted");
});

test("span bounds that disagree with the quote are rejected", () => {
  has(errorsFor(candidate({ evidence: { quote: "We should use Postgres", spanStart: 0, spanEnd: 43 } })),
    "evidence quote does not exactly match the source span");
  has(errorsFor(candidate({ evidence: { quote: TEXT, spanStart: 0, spanEnd: 44 } })),
    "exceeds episode length");
  has(errorsFor(candidate({ evidence: { quote: TEXT, spanStart: 10, spanEnd: 10 } })),
    "invalid source span bounds");
  has(errorsFor(candidate({ evidence: { quote: "   ", spanStart: 0, spanEnd: 3 } })),
    "evidence quote is empty");
});

test("an invented subject or an object outside the cited span is rejected", () => {
  has(errorsFor(candidate({ subject: { name: "MongoDB" } })),
    "subject 'MongoDB' does not appear in the source episode");
  has(errorsFor(candidate({ object: { kind: "entity", name: "MySQL", type: "product" } })),
    "object 'MySQL' does not appear in the cited source span");
});

test("negative polarity requires a negation cue in the cited sentence", () => {
  has(errorsFor(candidate({ polarity: "negative" })), "negation cue");

  const text = "We must not use MongoDB.";
  const ep = episode({ id: "ep-mongo", externalId: "ext-mongo", text, occurredAt: "2026-11-17T09:00:00.000Z" });
  const withCue = candidate({
    subject: { name: "We" },
    predicate: "must not use",
    object: { kind: "entity", name: "MongoDB", type: "product" },
    polarity: "negative",
    modality: "asserted",
    evidence: { quote: text, spanStart: 0, spanEnd: text.length },
  });
  assert.equal(run([withCue], ep).rejected.length, 0, "an explicit prohibition is a valid negative statement");
});

test("a question cannot be asserted, but an imperative 'Do use …' is not a question", () => {
  const qText = "Should we use Redis for caching?";
  const qEp = episode({ id: "ep-q", externalId: "ext-q", text: qText, occurredAt: "2026-11-17T10:00:00.000Z" });
  const asFact = candidate({
    subject: { name: "we" },
    predicate: "use",
    object: { kind: "entity", name: "Redis", type: "product" },
    modality: "asserted",
    evidence: { quote: qText, spanStart: 0, spanEnd: qText.length },
  });
  has(errorsFor(asFact, qEp), "question text cannot be extracted as modality 'asserted'");

  // The asked_about meta-form is the one admissible rendering of a question.
  const asQuestion = candidate({
    subject: { name: "we" },
    predicate: "asked_about",
    object: { kind: "entity", name: "Redis", type: "product" },
    modality: "questioned",
    category: "question",
    evidence: { quote: qText, spanStart: 0, spanEnd: qText.length },
  });
  assert.equal(run([asQuestion], qEp).rejected.length, 0);

  // Regression: a leading "Do" is an imperative, not an interrogative.
  const doText = "Do use MongoDB for the core database.";
  const doEp = episode({ id: "ep-do", externalId: "ext-do", text: doText, occurredAt: "2026-11-17T11:00:00.000Z" });
  const imperative = candidate({
    subject: { name: "MongoDB" },
    predicate: "use",
    object: { kind: "literal", value: "core database" },
    modality: "asserted",
    category: "constraint",
    evidence: { quote: doText, spanStart: 0, spanEnd: doText.length },
  });
  assert.equal(run([imperative], doEp).rejected.length, 0, "an imperative must not be misread as a question");
});

test("hypothetical wording may be proposed but never asserted or decided", () => {
  const text = "If we migrated to ClickHouse, queries would be much faster.";
  const ep = episode({ id: "ep-h", externalId: "ext-h", text, occurredAt: "2026-11-17T12:00:00.000Z" });
  const hypo = (modality: CandidateStatement["modality"], decisionStatus?: CandidateStatement["decisionStatus"]) =>
    candidate({
      subject: { name: "we" },
      predicate: "migrate to",
      object: { kind: "entity", name: "ClickHouse", type: "product" },
      modality,
      decisionStatus,
      evidence: { quote: text, spanStart: 0, spanEnd: text.length },
    });

  has(errorsFor(hypo("asserted"), ep), "hypothetical text cannot be extracted as modality 'asserted'");
  has(errorsFor(hypo("decided", "accepted"), ep), "hypothetical text cannot be extracted as modality 'decided'");
  assert.equal(run([hypo("proposed")], ep).rejected.length, 0, "a proposal is not a commitment");
  assert.equal(run([hypo("hypothetical")], ep).rejected.length, 0);
  assert.equal(run([hypo("uncertain")], ep).rejected.length, 0);
});

test("hedged wording cannot become a plain fact or an accepted decision", () => {
  // TEXT begins "We should use …" — "should" is a hedge.
  has(errorsFor(candidate({ modality: "asserted" })), "tentative text cannot be extracted as modality 'asserted'");
  has(errorsFor(candidate({ modality: "decided", decisionStatus: "accepted" })),
    "tentative text cannot be extracted as modality 'decided'");
  assert.equal(run([candidate()]).rejected.length, 0, "'should use' as a proposal is legitimate");
});

test("decisionStatus must be coherent with modality", () => {
  has(errorsFor(candidate({ decisionStatus: "accepted" })),
    "decisionStatus 'accepted' is incoherent with modality 'proposed'");
  assert.equal(run([candidate({ decisionStatus: "proposed" })]).rejected.length, 0);
});

test("resolved temporal bounds require wording, a declared precision, and an expression from the episode", () => {
  const text = "We shortlisted Attio on Monday for the sales team.";
  const ep = episode({
    id: "ep-t", externalId: "ext-t", text,
    occurredAt: "2026-11-04T02:00:00.000Z", tz: "Asia/Tokyo", createdAt: "2026-11-04T02:00:00.000Z",
  });
  const temporal = (t: Partial<NonNullable<CandidateStatement["temporal"]>>) =>
    candidate({
      subject: { name: "We" },
      predicate: "shortlisted",
      object: { kind: "entity", name: "Attio", type: "product" },
      modality: "shortlisted",
      temporal: {
        expression: "on Monday",
        validFrom: "2026-11-02T00:00:00.000Z",
        timePrecision: "day",
        validity: "open_ended",
        ...t,
      },
      evidence: { quote: text, spanStart: 0, spanEnd: text.length },
    });

  has(errorsFor(temporal({ expression: null }), ep), "resolved temporal bounds require the original temporal expression");
  has(errorsFor(temporal({ timePrecision: "unknown" }), ep), "resolved temporal bounds require a declared time precision");
  has(errorsFor(temporal({ expression: "next Tuesday" }), ep), "does not appear in the source episode");
  has(errorsFor(temporal({ validity: "open_ended", validTo: "2026-11-03T00:00:00.000Z" }), ep),
    "validity 'open_ended' cannot have validTo");
  assert.equal(run([temporal({})], ep).rejected.length, 0, "the correctly resolved Monday is accepted");
});

test("a relative weekday resolves against the episode's own timezone", () => {
  const text = "We shortlisted Attio on Monday for the sales team.";
  const ep = episode({
    id: "ep-t", externalId: "ext-t", text,
    occurredAt: "2026-11-04T02:00:00.000Z", tz: "Asia/Tokyo", createdAt: "2026-11-04T02:00:00.000Z",
  });
  const shortlist = (validFrom: string) =>
    candidate({
      subject: { name: "We" },
      predicate: "shortlisted",
      object: { kind: "entity", name: "Attio", type: "product" },
      modality: "shortlisted",
      temporal: { expression: "on Monday", validFrom, timePrecision: "day", validity: "open_ended" },
      evidence: { quote: text, spanStart: 0, spanEnd: text.length },
    });

  // 2026-11-04 is a Wednesday, so bare "on Monday" is 2026-11-02 in Asia/Tokyo.
  assert.equal(run([shortlist("2026-11-02T00:00:00.000Z")], ep).rejected.length, 0);
  has(errorsFor(shortlist("2026-11-09T00:00:00.000Z"), ep),
    "resolves to 2026-11-02 in Asia/Tokyo for this episode, not 2026-11-09");
});

test("the same instant and wording justify different dates in different timezones", () => {
  const text = "The demo is today.";
  const at = "2026-11-04T20:00:00.000Z"; // 05:00 on Nov 5 in Tokyo, still Nov 4 in UTC
  const tokyo = episode({ id: "ep-tz", externalId: "ext-tz", text, occurredAt: at, tz: "Asia/Tokyo", createdAt: at });
  const utc = episode({ id: "ep-utc", externalId: "ext-utc", text, occurredAt: at, tz: "UTC", createdAt: at });
  const today = (validFrom: string) =>
    candidate({
      subject: { name: "The demo" },
      predicate: "is",
      object: { kind: "literal", value: "today" },
      modality: "asserted",
      temporal: { expression: "today", validFrom, timePrecision: "day", validity: "open_ended" },
      evidence: { quote: text, spanStart: 0, spanEnd: text.length },
    });

  assert.equal(run([today("2026-11-05T00:00:00.000Z")], tokyo).rejected.length, 0);
  has(errorsFor(today("2026-11-04T00:00:00.000Z"), tokyo), "resolves to 2026-11-05 in Asia/Tokyo");

  assert.equal(run([today("2026-11-04T00:00:00.000Z")], utc).rejected.length, 0);
  has(errorsFor(today("2026-11-05T00:00:00.000Z"), utc), "resolves to 2026-11-04 in UTC");
});

test("statement identity is stable across scope-key and qualification ordering", () => {
  const text = "We should use Postgres for the new service, for the pilot per Q4 plan.";
  const ep = episode({ id: "ep-canon", externalId: "ext-canon", text, occurredAt: "2026-11-18T09:00:00.000Z" });
  const canon = (over: Partial<CandidateStatement>) =>
    candidate({
      evidence: { quote: text, spanStart: 0, spanEnd: text.length },
      ...over,
    });

  const a = run([canon({ scope: { region: "eu", team: "sales" }, qualifications: ["for the pilot", "per Q4 plan"] })], ep);
  const b = run([canon({ scope: { team: "sales", region: "eu" }, qualifications: ["per Q4 plan", "for the pilot"] })], ep);
  assert.equal(a.rejected.length, 0);
  assert.equal(b.rejected.length, 0);
  assert.equal(
    a.accepted[0]!.statement.id,
    b.accepted[0]!.statement.id,
    "a reordered model result must not mint a different statement id",
  );
  assert.deepEqual(
    JSON.parse(a.accepted[0]!.statement.predicateQualifier!.qualifications!),
    ["for the pilot", "per Q4 plan"],
    "stored qualifications are canonicalized so retries hash identically",
  );
  assert.deepEqual(
    Object.keys(a.accepted[0]!.statement.predicateQualifier!),
    Object.keys(b.accepted[0]!.statement.predicateQualifier!),
    "qualifier key order is deterministic",
  );
});

test("statement identity follows the predicateText casing persisted in the qualifier", () => {
  const lower = run([candidate({ predicate: "should use" })]).accepted[0]!.statement;
  const upper = run([candidate({ predicate: "SHOULD USE" })]).accepted[0]!.statement;
  assert.equal(lower.predicate, upper.predicate, "both casings normalize to the same predicate");
  assert.notEqual(lower.predicateQualifier!.predicateText, upper.predicateQualifier!.predicateText);
  assert.notEqual(lower.id, upper.id, "different persisted predicateText must not share a statement id");
});

test("statement identity includes the persisted confidence", () => {
  const low = run([candidate({ confidence: 0.8 })]).accepted[0]!.statement;
  const high = run([candidate({ confidence: 0.9 })]).accepted[0]!.statement;
  assert.equal(low.confidence, 0.8);
  assert.equal(high.confidence, 0.9);
  assert.notEqual(low.id, high.id, "a different immutable confidence must not reuse a statement id");
});

test("statement identity includes the object entity type", () => {
  const asProduct = run([candidate({ object: { kind: "entity", name: "Postgres", type: "product" } })]).accepted[0]!.statement;
  const asConcept = run([candidate({ object: { kind: "entity", name: "Postgres", type: "concept" } })]).accepted[0]!.statement;
  const asDefault = run([candidate({ object: { kind: "entity", name: "Postgres" } })]).accepted[0]!.statement;
  assert.notEqual(asProduct.objectId, asConcept.objectId, "object entity ids are type-derived");
  assert.notEqual(asProduct.id, asConcept.id, "a different objectId must change the statement id");
  assert.equal(asDefault.objectId, asConcept.objectId, "an omitted type must use the same 'concept' default");
  assert.equal(asDefault.id, asConcept.id, "the type default must not mint a distinguishable id");
});

test("a changed extraction version produces a distinguishable statement id", () => {
  const one = run([candidate()]).accepted[0]!.statement.id;
  const two = validateCandidates({
    episode: episode(),
    candidates: [candidate()],
    extractionModel: "test-model",
    extractionPromptHash: "prompt-hash",
    extractionVersion: "extract/2",
    recordedAt: "2026-11-19T00:00:00.000Z",
  }).accepted[0]!.statement.id;
  assert.notEqual(one, two, "reprocessing under a new extractor version must be distinguishable");
});

test("identical candidates within one result are collapsed, not duplicated", () => {
  const r = run([candidate(), candidate()]);
  assert.equal(r.accepted.length, 1);
  assert.equal(r.duplicateCandidates, 1);
  assert.equal(r.rejected.length, 0);
});

test("qualifications and reserved scope keys must be grounded in the episode", () => {
  has(errorsFor(candidate({ qualifications: ["per Q4 budget"] })), "does not appear in the source episode");
  has(errorsFor(candidate({ scope: { decisionStatus: "accepted" } })), "scope key 'decisionStatus' is reserved");
  has(errorsFor(candidate({ predicate: "???" })), "predicate is empty after normalization");
});

test("epistemic status follows the episode role rather than the model's claim", () => {
  const assistant = episode({ id: "ep-a", externalId: "ext-a", role: "assistant" });
  const w = run([candidate()], assistant).accepted[0]!.statement;
  assert.equal(w.assertedBy, "assistant");
  assert.equal(w.epistemicStatus, "model_inferred");
});

test("normalization helpers are idempotent and predictable", () => {
  assert.equal(normalizePredicate("Should  Use-Postgres"), "should_use_postgres");
  assert.equal(normalizePredicate("should use"), "should_use");
  assert.equal(normalizePredicate("???"), "");
  assert.equal(normalizeMention("  We   should  "), "We should");
  assert.equal(normalizeMention(normalizeMention("  We   should  ")), "We should");
});

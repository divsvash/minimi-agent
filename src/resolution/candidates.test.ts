import { test } from "node:test";
import assert from "node:assert/strict";
import type { Entity, ResolutionRequest } from "../contracts/schemas.js";
import { ScriptedEmbeddingProvider } from "../fakes/scriptedEmbeddingProvider.js";
import { generateCandidates, trigramSimilarity } from "./candidates.js";
import { decide } from "./policy.js";

const entity = (over: Partial<Entity> = {}): Entity => ({
  id: "ent-a",
  type: "product",
  canonicalName: "Atlas CRM",
  aliases: [],
  status: "active",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  ...over,
});

const request = (over: Partial<ResolutionRequest> = {}): ResolutionRequest => ({
  mention: { name: "Atlas CRM", type: "product" },
  context: "We use Atlas CRM.",
  ...over,
});

test("candidate generation records every signal that produced a candidate", async () => {
  const candidates = await generateCandidates({
    request: request(),
    entities: [entity({ aliases: ["Atlas CRM"] })],
  });
  assert.equal(candidates.length, 1);
  const kinds = candidates[0]!.signals.map((s) => s.kind);
  assert.ok(kinds.includes("exact_canonical_name"));
  assert.ok(kinds.includes("exact_alias"));
  assert.ok(kinds.includes("same_type"));
  assert.ok(candidates[0]!.score > 0);
});

test("type incompatibility is a hard barrier and same-type alone is not a candidate", async () => {
  const wrongType = await generateCandidates({
    request: request({ mention: { name: "Atlas CRM", type: "org" } }),
    entities: [entity()],
  });
  assert.equal(wrongType.length, 0, "the type-mismatched entity is never surfaced");

  const unrelated = await generateCandidates({
    request: request({ mention: { name: "Zebra", type: "product" } }),
    entities: [entity()],
  });
  assert.equal(unrelated.length, 0, "a shared type is not a similarity signal");
});

test("trigram similarity is ranked but never marked authoritative", async () => {
  assert.ok(trigramSimilarity("Atlas", "Atlas CRM") > trigramSimilarity("Atlas", "Zebra"));
  const candidates = await generateCandidates({
    request: request({ mention: { name: "Atlas", type: "product" } }),
    entities: [entity({ id: "ent-a", canonicalName: "Atlas CRM" }), entity({ id: "ent-b", canonicalName: "Zebra" })],
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.entityId, "ent-a");
  assert.ok(candidates[0]!.signals.some((s) => s.kind === "trigram"));
  assert.equal(candidates[0]!.authoritative, false);
  assert.equal(decide(request({ mention: { name: "Atlas", type: "product" } }), candidates).outcome, "review_required");
});

test("an embedding signal generates a candidate but cannot authorize identity", async () => {
  const embeddings = new ScriptedEmbeddingProvider({ Atlas: [1, 0], "Atlas CRM": [1, 0] });
  const candidates = await generateCandidates({
    request: request({ mention: { name: "Atlas", type: "product" } }),
    entities: [entity()],
    embeddings,
  });
  assert.ok(candidates[0]!.signals.some((s) => s.kind === "embedding"));
  assert.equal(candidates[0]!.authoritative, false);
  const decision = decide(request({ mention: { name: "Atlas", type: "product" } }), candidates);
  assert.equal(decision.outcome, "review_required");
  assert.ok(decision.rationale.includes("insufficient"));
});

test("external id and prior confirmation are authoritative; duplicate authority is ambiguous", async () => {
  const withExternal = await generateCandidates({
    request: request({ evidence: { externalIds: { wikidata: "Q42" } } }),
    entities: [entity({ externalIds: { wikidata: "Q42" } })],
  });
  assert.equal(decide(request(), withExternal).outcome, "matched");

  const confirmed = await generateCandidates({
    request: request({ evidence: { confirmedEntityId: "ent-a" } }),
    entities: [entity()],
  });
  assert.equal(decide(request(), confirmed).outcome, "matched");

  const two = await generateCandidates({
    request: request({ evidence: { confirmedEntityId: "ent-a", externalIds: { wikidata: "Q42" } } }),
    entities: [entity(), entity({ id: "ent-b", externalIds: { wikidata: "Q42" } })],
  });
  assert.equal(decide(request(), two).outcome, "ambiguous");
});

test("two exact canonical names never produce a silent winner", async () => {
  const candidates = await generateCandidates({
    request: request({ mention: { name: "Atlas", type: "product" } }),
    entities: [entity({ id: "ent-a", canonicalName: "Atlas" }), entity({ id: "ent-b", canonicalName: "Atlas" })],
  });
  const decision = decide(request({ mention: { name: "Atlas", type: "product" } }), candidates);
  assert.equal(decision.outcome, "ambiguous");
  assert.ok(!("entityId" in decision));
});

test("new_entity ids are deterministic for identical requests", () => {
  const a = decide(request({ mention: { name: "Zebra", type: "product" } }), []);
  const b = decide(request({ mention: { name: "Zebra", type: "product" } }), []);
  assert.equal(a.outcome, "new_entity");
  assert.ok("entityId" in a && "entityId" in b);
  assert.equal(a.entityId, b.entityId);
});

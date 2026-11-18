import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAssertion, applyAssertions, resolvePath } from "./matchers.js";

test("resolvePath walks nested objects and arrays", () => {
  const doc = { a: { b: [{ c: "x" }, { c: "y" }] } };
  assert.deepEqual(resolvePath(doc, "a.b.1.c"), { found: true, value: "y" });
  assert.equal(resolvePath(doc, "a.b.9.c").found, false);
  assert.equal(resolvePath(doc, "a.missing").found, false);
  assert.equal(resolvePath(null, "a").found, false);
});

test("eq/neq/oneOf/includes/length/gte/lte/exists semantics", () => {
  const doc = { verdict: "changed", claims: ["a", "b"], n: 3, nested: { flag: true } };
  assert.equal(applyAssertion(doc, { path: "verdict", op: "eq", value: "changed" }).pass, true);
  assert.equal(applyAssertion(doc, { path: "verdict", op: "eq", value: "unchanged" }).pass, false);
  assert.equal(applyAssertion(doc, { path: "verdict", op: "neq", value: "verified_unchanged" }).pass, true);
  assert.equal(applyAssertion(doc, { path: "verdict", op: "oneOf", value: ["changed", "insufficient_evidence"] }).pass, true);
  assert.equal(applyAssertion(doc, { path: "claims", op: "length", value: 2 }).pass, true);
  assert.equal(applyAssertion(doc, { path: "claims", op: "includes", value: "b" }).pass, true);
  assert.equal(applyAssertion(doc, { path: "claims", op: "includes", value: "zz" }).pass, false);
  assert.equal(applyAssertion(doc, { path: "n", op: "gte", value: 3 }).pass, true);
  assert.equal(applyAssertion(doc, { path: "n", op: "lte", value: 2 }).pass, false);
  assert.equal(applyAssertion(doc, { path: "nested.flag", op: "exists" }).pass, true);
  assert.equal(applyAssertion(doc, { path: "nested.missing", op: "exists" }).pass, false);
});

test("eq is structural, not reference-based", () => {
  const a = { x: [1, 2], y: { z: "q" } };
  assert.equal(applyAssertion({ doc: a }, { path: "doc", op: "eq", value: { x: [1, 2], y: { z: "q" } } }).pass, true);
});

test("applyAssertions reports each failing assertion with actual value", () => {
  const results = applyAssertions(
    { b: 2 },
    [
      { path: "b", op: "eq", value: 2 },
      { path: "b", op: "eq", value: 3 },
    ],
  );
  assert.equal(results.filter((r) => r.pass).length, 1);
  assert.equal(results[1]!.actual, 2);
});

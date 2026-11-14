import { test } from "node:test";
import assert from "node:assert/strict";
import { ids } from "./ids.js";

test("jobKey is stable and normalized", () => {
  assert.equal(ids.jobKey("extract", "Ep_ABC"), "extract:ep_abc");
  assert.equal(ids.jobKey("research", "Attio", "pricing.amount", "USD|monthly"), "research:attio:pricing.amount:usd|monthly");
});

test("sha256 deterministic", () => {
  assert.equal(ids.sha256("x"), ids.sha256("x"));
  assert.notEqual(ids.sha256("x"), ids.sha256("y"));
});

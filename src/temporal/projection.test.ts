import { test } from "node:test";
import assert from "node:assert/strict";
import type { LifecycleEvent } from "../contracts/schemas.js";
import { projectStatus, visibleAt } from "./projection.js";

const event = (over: Partial<LifecycleEvent> = {}): LifecycleEvent => ({
  id: "lc:1",
  kind: "superseded",
  targetId: "st-1",
  at: "2026-11-20T00:00:00.000Z",
  actor: "user",
  reason: "changed",
  planHash: "hash",
  ...over,
});

test("status is derived from events, not stored on the statement", () => {
  assert.equal(projectStatus("st-1", []), "active");
  assert.equal(projectStatus("st-1", [event()]), "superseded");
  assert.equal(projectStatus("st-1", [event({ kind: "retracted" })]), "retracted");
  assert.equal(projectStatus("st-1", [event({ kind: "conflicted", otherId: "st-2" })]), "conflicted");
});

test("as-of transaction time ignores events recorded later", () => {
  const events = [event()];
  assert.equal(projectStatus("st-1", events, new Date("2026-11-10T00:00:00.000Z")), "active");
  assert.equal(projectStatus("st-1", events, new Date("2026-11-21T00:00:00.000Z")), "superseded");
});

test("superseded and retracted statements are hidden, conflicted ones stay visible", () => {
  assert.equal(visibleAt("st-1", [event()]), false);
  assert.equal(visibleAt("st-1", [event({ kind: "retracted" })]), false);
  assert.equal(visibleAt("st-1", [event({ kind: "conflicted", otherId: "st-2" })]), true);
  assert.equal(visibleAt("st-2", []), true);
});

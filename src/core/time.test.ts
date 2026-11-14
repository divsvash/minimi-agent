import { test } from "node:test";
import assert from "node:assert/strict";
import { dayRangeUtc, zonedMidnightToUtc } from "./time.js";

test("dayRangeUtc respects tz across DST transition (Europe/Lisbon 2026-10-25)", () => {
  // DST ends 2026-10-25 in Lisbon; day is 25 hours long
  const { from, to } = dayRangeUtc("2026-10-25", "Europe/Lisbon");
  assert.equal((to.getTime() - from.getTime()) / 3600_000, 25);
  assert.equal(from.toISOString(), "2026-10-24T23:00:00.000Z"); // 2026-10-24T23:00Z = 2026-10-25T00:00+01:00
  assert.equal(to.toISOString(), "2026-10-26T00:00:00.000Z");   // back to UTC at 2026-10-26T00:00+00:00
});

test("dayRangeUtc for a plain winter day in Lisbon equals UTC midnight±0", () => {
  const { from, to } = dayRangeUtc("2026-11-03", "Europe/Lisbon");
  assert.equal(from.toISOString(), "2026-11-03T00:00:00.000Z"); // Lisbon is UTC+0 in November
  assert.equal(to.getTime() - from.getTime(), 24 * 3600_000);
});

test("zonedMidnightToUtc handles UTC+5:30 (Asia/Kolkata)", () => {
  assert.equal(zonedMidnightToUtc("2026-11-03", "Asia/Kolkata").toISOString(), "2026-11-02T18:30:00.000Z");
});

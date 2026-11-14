import { test } from "node:test";
import assert from "node:assert/strict";
import { dayRangeUtc, zonedMidnightToUtc } from "./time.js";

test("dayRangeUtc: Lisbon summer (UTC+1) — local midnight is 23:00Z the previous day", () => {
  const { from, to } = dayRangeUtc("2026-07-01", "Europe/Lisbon");
  assert.equal(from.toISOString(), "2026-06-30T23:00:00.000Z"); // 2026-07-01T00:00+01:00
  assert.equal(to.toISOString(), "2026-07-01T23:00:00.000Z");   // 2026-07-02T00:00+01:00
  assert.equal((to.getTime() - from.getTime()) / 3600_000, 24);
});

test("dayRangeUtc: DST spring-forward day (Europe/Lisbon 2026-03-29) is 23 hours", () => {
  const { from, to } = dayRangeUtc("2026-03-29", "Europe/Lisbon");
  assert.equal((to.getTime() - from.getTime()) / 3600_000, 23); // 01:00→02:00 skipped
});

test("dayRangeUtc: DST fall-back day (Europe/Lisbon 2026-10-25) is 25 hours", () => {
  const { from, to } = dayRangeUtc("2026-10-25", "Europe/Lisbon");
  assert.equal((to.getTime() - from.getTime()) / 3600_000, 25); // 01:00–02:00 repeated
  assert.equal(from.toISOString(), "2026-10-24T23:00:00.000Z");
  assert.equal(to.toISOString(), "2026-10-26T00:00:00.000Z");
});

test("dayRangeUtc: Lisbon winter is UTC+0 (offset differs from summer case)", () => {
  const { from, to } = dayRangeUtc("2026-11-03", "Europe/Lisbon");
  assert.equal(from.toISOString(), "2026-11-03T00:00:00.000Z");
  assert.equal(to.toISOString(), "2026-11-04T00:00:00.000Z");
});

test("zonedMidnightToUtc handles UTC+5:30 (Asia/Kolkata)", () => {
  assert.equal(zonedMidnightToUtc("2026-11-03", "Asia/Kolkata").toISOString(), "2026-11-02T18:30:00.000Z");
});

test("zonedMidnightToUtc handles UTC−5 (America/New_York winter)", () => {
  assert.equal(zonedMidnightToUtc("2026-11-03", "America/New_York").toISOString(), "2026-11-03T05:00:00.000Z");
});

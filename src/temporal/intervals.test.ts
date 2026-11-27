import { test } from "node:test";
import assert from "node:assert/strict";
import type { Statement } from "../contracts/schemas.js";
import { missingTemporalInfo, statementValidAt } from "./intervals.js";

const interval = (over: Partial<Pick<Statement, "validFrom" | "validTo" | "timePrecision" | "validity">> = {}) => ({
  validFrom: null,
  validTo: null,
  timePrecision: "unknown" as const,
  validity: "open_ended" as const,
  ...over,
});

const at = (iso: string) => new Date(iso);

test("a future valid-time start is not visible before it begins", () => {
  const s = interval({ validFrom: "2026-12-01T00:00:00.000Z", validity: "open_ended" });
  assert.equal(statementValidAt(s, at("2026-11-15T00:00:00.000Z")), false);
  assert.equal(statementValidAt(s, at("2026-12-05T00:00:00.000Z")), true);
});

test("bounded intervals are half-open", () => {
  const s = interval({
    validFrom: "2026-11-01T00:00:00.000Z",
    validTo: "2026-11-10T00:00:00.000Z",
    timePrecision: "day",
    validity: "bounded",
  });
  assert.equal(statementValidAt(s, at("2026-11-01T00:00:00.000Z")), true);
  assert.equal(statementValidAt(s, at("2026-11-09T23:59:59.000Z")), true);
  assert.equal(statementValidAt(s, at("2026-11-10T00:00:00.000Z")), false);
});

test("ongoing ignores a stored upper bound while open_ended honours none", () => {
  const ongoing = interval({
    validFrom: "2026-11-01T00:00:00.000Z",
    validTo: "2026-11-10T00:00:00.000Z",
    validity: "ongoing",
  });
  assert.equal(statementValidAt(ongoing, at("2026-12-01T00:00:00.000Z")), true);
  const open = interval({ validFrom: "2026-11-01T00:00:00.000Z", validity: "open_ended" });
  assert.equal(statementValidAt(open, at("2027-01-01T00:00:00.000Z")), true);
});

test("day and month precision widen bounds to the interval they denote", () => {
  const day = interval({ validFrom: "2026-11-05T17:30:00.000Z", timePrecision: "day", validity: "open_ended" });
  assert.equal(statementValidAt(day, at("2026-11-05T01:00:00.000Z")), true);
  assert.equal(statementValidAt(day, at("2026-11-04T23:59:59.000Z")), false);

  const month = interval({ validFrom: "2026-11-18T12:00:00.000Z", timePrecision: "month", validity: "open_ended" });
  assert.equal(statementValidAt(month, at("2026-11-02T00:00:00.000Z")), true);
  assert.equal(statementValidAt(month, at("2026-10-31T23:59:59.000Z")), false);
});

test("missing temporal information is never invented", () => {
  const unknown = interval({ timePrecision: "unknown", validity: "open_ended" });
  assert.equal(statementValidAt(unknown, at("2020-01-01T00:00:00.000Z")), true);
  assert.equal(statementValidAt(unknown, at("2099-01-01T00:00:00.000Z")), true);
  assert.deepEqual(missingTemporalInfo(unknown), { validFrom: null, validTo: null });
});

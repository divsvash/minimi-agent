import { dayRangeUtc } from "../core/time.js";
import type { Statement } from "../contracts/schemas.js";

/**
 * One interval implementation shared by the Neo4j store and the offline twin.
 * Valid-time bounds are half-open [start, end). `null` means unknown / unbounded
 * — never epoch and never "now". Precision widens a stored instant to the
 * interval it actually denotes (a `day` bound covers the whole UTC day).
 */

type Interval = Pick<Statement, "validFrom" | "validTo" | "timePrecision" | "validity">;

function bound(value: string, precision: Statement["timePrecision"]): { start: number; end: number } {
  const exact = new Date(value).getTime();
  if (precision === "day") {
    const { from, to } = dayRangeUtc(value.slice(0, 10), "UTC");
    return { start: from.getTime(), end: to.getTime() };
  }
  if (precision === "month" || precision === "year") {
    const d = new Date(value);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    if (precision === "month") {
      return { start: Date.UTC(y, m, 1), end: Date.UTC(y, m + 1, 1) };
    }
    return { start: Date.UTC(y, 0, 1), end: Date.UTC(y + 1, 0, 1) };
  }
  if (precision === "minute") {
    const start = Math.floor(exact / 60_000) * 60_000;
    return { start, end: start + 60_000 };
  }
  // second / unknown: no widening. An unknown instant is never invented.
  return { start: exact, end: exact };
}

export function statementValidAt(statement: Interval, at: Date): boolean {
  const t = at.getTime();
  const lower = statement.validFrom ? bound(statement.validFrom, statement.timePrecision).start : null;
  const hasUpper = statement.validity !== "ongoing" && statement.validity !== "open_ended";
  const upper = hasUpper && statement.validTo ? bound(statement.validTo, statement.timePrecision).start : null;
  return (lower === null || lower <= t) && (upper === null || t < upper);
}

/** Deterministic fallback when a query omits a temporal axis: no filtering. */
export function missingTemporalInfo(statement: Interval): { validFrom: string | null; validTo: string | null } {
  return { validFrom: statement.validFrom ?? null, validTo: statement.validTo ?? null };
}

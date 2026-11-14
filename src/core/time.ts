/** Timezone-aware day-boundary math (no dependencies). All outputs are UTC Date ranges. */

function tzOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asIfUtc = Date.UTC(
    get("year"), get("month") - 1, get("day"),
    get("hour") % 24, get("minute"), get("second"),
  );
  return asIfUtc - instant.getTime();
}

/** UTC instant of local midnight (00:00) for `dateStr` (YYYY-MM-DD) in `timeZone`. */
export function zonedMidnightToUtc(dateStr: string, timeZone: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d);
  const approx = new Date(naive - tzOffsetMs(new Date(naive), timeZone));
  return new Date(naive - tzOffsetMs(approx, timeZone));
}

/** Half-open UTC range [from, to) covering the local calendar day in `timeZone`. */
export function dayRangeUtc(dateStr: string, timeZone: string): { from: Date; to: Date } {
  const from = zonedMidnightToUtc(dateStr, timeZone);
  const next = new Date(from.getTime() + 36 * 3600 * 1000); // safe overshoot for DST
  const nextParts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(next);
  return { from, to: zonedMidnightToUtc(nextParts, timeZone) };
}

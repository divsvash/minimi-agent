import type { Clock } from "../core/clock.js";

/** Mutable clock for tests: time only moves when the test says so. */
export class FakeClock implements Clock {
  private current: Date;
  constructor(start: Date = new Date("2026-11-19T00:00:00.000Z")) {
    this.current = new Date(start.getTime());
  }
  now(): Date {
    return new Date(this.current.getTime());
  }
  set(d: Date): void {
    this.current = new Date(d.getTime());
  }
  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  advanceSeconds(s: number): void {
    this.advanceMs(s * 1000);
  }
  advanceMinutes(m: number): void {
    this.advanceMs(m * 60_000);
  }
  advanceHours(h: number): void {
    this.advanceMs(h * 3_600_000);
  }
  advanceDays(d: number): void {
    this.advanceMs(d * 86_400_000);
  }
}

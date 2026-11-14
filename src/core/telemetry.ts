/** Minimal telemetry counters/timers. No-op sink by default; tests inject MemoryTelemetry. */
export interface Telemetry {
  incr(name: string, value?: number): void;
  timing(name: string, ms: number): void;
}

export const noopTelemetry: Telemetry = { incr: () => {}, timing: () => {} };

export class MemoryTelemetry implements Telemetry {
  counters = new Map<string, number>();
  timings: { name: string; ms: number }[] = [];
  incr(name: string, value = 1) {
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }
  timing(name: string, ms: number) {
    this.timings.push({ name, ms });
  }
}

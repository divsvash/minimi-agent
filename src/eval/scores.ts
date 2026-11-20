/**
 * Per-case numeric measurements recorded by a SUT handler (in addition to the
 * pass/fail assertions). Scores are rates or losses, not provider cost. They are
 * aggregated only across cases that actually executed.
 */
export interface ScoreEntry {
  name: string;
  value: number;
}

export class ScoreCollector {
  private readonly entries: ScoreEntry[] = [];

  record(name: string, value: number): void {
    if (!name.trim()) throw new RangeError("score name must be non-empty");
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`score '${name}' must be finite and non-negative; got ${value}`);
    }
    this.entries.push({ name, value });
  }

  all(): readonly ScoreEntry[] {
    return [...this.entries];
  }
}

/**
 * Per-case usage/cost collector for evaluation runs.
 * SUT handlers record provider usage here as they call fakes (or real providers,
 * later). A case that records nothing has NO measured provider cost: its zero
 * means no provider call was recorded, not that a provider was measured at zero.
 * CostSummary.basis distinguishes the two in the report.
 */
export class UsageCollector {
  private readonly entries: { source: string; usd: number }[] = [];

  record(source: string, usd: number): void {
    if (!Number.isFinite(usd) || usd < 0) {
      throw new RangeError(`cost must be a finite, non-negative number; got ${usd} for source '${source}'`);
    }
    this.entries.push({ source, usd });
  }

  totalUsd(): number {
    return this.entries.reduce((sum, e) => sum + e.usd, 0);
  }

  breakdown(): readonly { source: string; usd: number }[] {
    return [...this.entries];
  }
}

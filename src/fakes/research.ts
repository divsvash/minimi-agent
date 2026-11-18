import type { Observation } from "../contracts/schemas.js";
import type { ResearchAttempt, ResearchOutcome, ResearchProvider, ResearchRun } from "../contracts/ports.js";
import { ProviderTimeoutError } from "../core/errors.js";

export type ResearchScript =
  | { kind: "outcome"; outcome: Omit<ResearchOutcome, "run"> & { attempts: ResearchAttempt[]; queries?: string[] } }
  | { kind: "error"; error: Error };

/**
 * Deterministic in-memory ResearchProvider fake. Outcomes come from a FIFO script
 * (or a single repeating default). No network. Supports the failure modes the
 * verdict matrix cares about: empty results, fetch errors, conflicting sources,
 * dimension mismatch, stale sources.
 */
export class FakeResearchProvider implements ResearchProvider {
  readonly calls: { attribute: string; entity: string }[] = [];
  private script: ResearchScript[] = [];
  private defaultOutcome: Omit<ResearchOutcome, "run"> & { attempts: ResearchAttempt[] } = {
    verdict: "insufficient_evidence",
    reason: undefined,
    attempts: [{ outcome: "ok", relevant: false, authoritative: false, fresh: false }],
  };
  private clock: () => Date;
  private idSeq = 0;

  constructor(opts: { now?: () => Date } = {}) {
    this.clock = opts.now ?? (() => new Date("2026-11-19T00:00:00.000Z"));
  }

  enqueue(...items: ResearchScript[]): this {
    this.script.push(...items);
    return this;
  }
  setDefault(outcome: Omit<ResearchOutcome, "run"> & { attempts: ResearchAttempt[] }): this {
    this.defaultOutcome = outcome;
    return this;
  }

  async observe(request: {
    entity: { id?: string; name: string; type?: import("../contracts/schemas.js").EntityType };
    attribute: string;
    dimensions?: Record<string, string>;
    baseline?: Observation | null;
  }): Promise<ResearchOutcome> {
    this.calls.push({ attribute: request.attribute, entity: request.entity.name });
    const scripted = this.script.shift();
    if (scripted?.kind === "error") throw scripted.error;
    const body = scripted?.kind === "outcome" ? scripted.outcome : this.defaultOutcome;
    this.idSeq += 1;
    const nowIso = this.clock().toISOString();
    const run: ResearchRun = {
      id: `run-${String(this.idSeq).padStart(4, "0")}`,
      entity: request.entity.name,
      attribute: request.attribute,
      dimensions: request.dimensions ?? {},
      queries: (body as { queries?: string[] }).queries ?? [`${request.entity.name} ${request.attribute}`],
      startedAt: nowIso,
      completedAt: nowIso,
      attempts: body.attempts,
    };
    return { ...body, run };
  }

  timeoutOnce(): this {
    this.script.push({ kind: "error", error: new ProviderTimeoutError("fake research: scripted timeout") });
    return this;
  }

  reset(): void {
    this.calls.length = 0;
    this.script = [];
    this.idSeq = 0;
  }
}

/** Convenience constructors for the recurring verdict fixtures. */
export const researchFixtures = {
  /** Comparable + equal + authoritative + fresh. */
  verifiedUnchanged(value: string | number | boolean, source: string): Extract<ResearchScript, { kind: "outcome" }> {
    return {
      kind: "outcome",
      outcome: {
        verdict: "verified_unchanged",
        attempts: [
          {
            outcome: "ok", url: source, relevant: true, accessible: true,
            attributeExtracted: true, dimsComparable: true, value,
            sourceEffectiveAt: "2026-11-01T00:00:00.000Z", authoritative: true, fresh: true,
          },
        ],
      },
    };
  },
  /** Comparable + differs + authoritative + fresh. */
  changed(before: string | number | boolean, after: string | number | boolean, source: string): Extract<ResearchScript, { kind: "outcome" }> {
    void before;
    return {
      kind: "outcome",
      outcome: {
        verdict: "changed",
        attempts: [
          {
            outcome: "ok", url: source, relevant: true, accessible: true,
            attributeExtracted: true, dimsComparable: true, value: after,
            sourceEffectiveAt: "2026-11-18T00:00:00.000Z", authoritative: true, fresh: true,
          },
        ],
      },
    };
  },
  emptyResults(): Extract<ResearchScript, { kind: "outcome" }> {
    return {
      kind: "outcome",
      outcome: {
        verdict: "insufficient_evidence",
        attempts: [{ outcome: "ok", relevant: false, authoritative: false, fresh: false }],
      },
    };
  },
  dimensionMismatch(url: string): Extract<ResearchScript, { kind: "outcome" }> {
    return {
      kind: "outcome",
      outcome: {
        verdict: "no_change_found",
        reason: "dimension_mismatch",
        attempts: [
          {
            outcome: "ok", url, relevant: true, accessible: true,
            attributeExtracted: true, dimsComparable: false, authoritative: true, fresh: true,
          },
        ],
      },
    };
  },
  staleSource(sourceEffectiveAt: string, source: string): Extract<ResearchScript, { kind: "outcome" }> {
    return {
      kind: "outcome",
      outcome: {
        verdict: "no_change_found",
        reason: "stale_source",
        attempts: [
          {
            outcome: "ok", url: source, relevant: true, accessible: true,
            attributeExtracted: true, dimsComparable: true, authoritative: true,
            fresh: false, sourceEffectiveAt,
          },
        ],
      },
    };
  },
  conflictingSources(a: string, b: string): Extract<ResearchScript, { kind: "outcome" }> {
    return {
      kind: "outcome",
      outcome: {
        verdict: "no_change_found",
        reason: "conflicting_unresolved",
        attempts: [
          { outcome: "ok", url: a, relevant: true, accessible: true, attributeExtracted: true, dimsComparable: true, authoritative: true, fresh: true, conflictWith: b },
          { outcome: "ok", url: b, relevant: true, accessible: true, attributeExtracted: true, dimsComparable: true, authoritative: true, fresh: true, conflictWith: a },
        ],
      },
    };
  },
};

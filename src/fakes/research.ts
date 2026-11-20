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
 *
 * IMPORTANT: this fake scripts verdicts; it does not compute them. Passing tests
 * here demonstrate consumer behavior under scripted outcomes, never verdict-rule
 * correctness (slice 7).
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

/**
 * Scripted verdict fixtures for testing CONSUMERS of ResearchProvider.
 *
 * The fake still SCRIPTS the verdict; it does not compute one. To keep that honest,
 * changed()/verifiedUnchanged() carry the baseline and current observations a consumer
 * would compare: identical dimensions, and values that really differ (changed) or
 * really agree (verifiedUnchanged). Verdict-rule correctness (comparability, authority,
 * freshness, conflicts) remains Slice 7 work.
 */
const FIXTURE_CAPTURED_AT = "2026-11-19T00:00:00.000Z";
const FIXTURE_ATTRIBUTE = "pricing.amount";
const FIXTURE_DIMENSIONS = { plan: "team", billingPeriod: "monthly", currency: "USD" } as const;

type FixtureValue = string | number | boolean;

function fixtureObservation(opts: {
  id: string;
  value: FixtureValue;
  sourceUrl: string;
  sourceEffectiveAt: string;
}): Observation {
  return {
    id: opts.id,
    obsKey: `obs:${opts.id}`,
    attribute: FIXTURE_ATTRIBUTE,
    dimensions: { ...FIXTURE_DIMENSIONS },
    value: opts.value,
    sourceEffectiveAt: opts.sourceEffectiveAt,
    sourcePublishedAt: null,
    recordedAt: FIXTURE_CAPTURED_AT,
    source: {
      url: opts.sourceUrl,
      title: "Fixture source",
      publisher: new URL(opts.sourceUrl).hostname,
      publishedAt: null,
      accessedAt: FIXTURE_CAPTURED_AT,
    },
    extractionMethod: "manual",
    extractionConfidence: 1,
    obsNormVersion: 1,
  };
}

export const researchFixtures = {
  /** Comparable + equal + authoritative + fresh. Baseline and current are distinct
   *  observations with the same value, so consumers must compare values, not identity. */
  verifiedUnchanged(value: FixtureValue, source: string): Extract<ResearchScript, { kind: "outcome" }> {
    const baseline = fixtureObservation({
      id: `baseline:${String(value)}`,
      value,
      sourceUrl: source,
      sourceEffectiveAt: "2026-11-01T00:00:00.000Z",
    });
    const current = fixtureObservation({
      id: `current:${String(value)}`,
      value,
      sourceUrl: source,
      sourceEffectiveAt: "2026-11-18T00:00:00.000Z",
    });
    if (!Object.is(baseline.value, current.value)) {
      throw new Error("verifiedUnchanged fixture requires equal baseline/current values");
    }
    return {
      kind: "outcome",
      outcome: {
        verdict: "verified_unchanged",
        baseline,
        current,
        attempts: [
          {
            outcome: "ok", url: source, relevant: true, accessible: true,
            attributeExtracted: true, dimsComparable: true, value: current.value,
            sourceEffectiveAt: current.sourceEffectiveAt,
            authoritative: true, fresh: true,
          },
        ],
      },
    };
  },
  /** Comparable + differs + authoritative + fresh. Baseline and current carry the
   *  same dimensions and genuinely distinct values. */
  changed(before: FixtureValue, after: FixtureValue, source: string): Extract<ResearchScript, { kind: "outcome" }> {
    const baseline = fixtureObservation({
      id: `baseline:${String(before)}`,
      value: before,
      sourceUrl: source,
      sourceEffectiveAt: "2026-11-01T00:00:00.000Z",
    });
    const current = fixtureObservation({
      id: `current:${String(after)}`,
      value: after,
      sourceUrl: source,
      sourceEffectiveAt: "2026-11-18T00:00:00.000Z",
    });
    if (Object.is(baseline.value, current.value)) {
      throw new Error("changed fixture requires distinct baseline/current values");
    }
    return {
      kind: "outcome",
      outcome: {
        verdict: "changed",
        baseline,
        current,
        attempts: [
          {
            outcome: "ok", url: source, relevant: true, accessible: true,
            attributeExtracted: true, dimsComparable: true, value: current.value,
            sourceEffectiveAt: current.sourceEffectiveAt,
            authoritative: true, fresh: true,
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

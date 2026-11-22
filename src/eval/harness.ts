import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { GoldenCaseSchema, type GoldenCase } from "./goldenCase.js";
import { applyAssertions } from "./matchers.js";
import { computeMetrics, type CaseResult, type EvalMetrics } from "./metrics.js";
import {
  summarizeCost, summarizeExtractionScores, summarizeScenarios,
  type ChallengeSummary, type CostSummary, type ExtractionSummary,
} from "./summary.js";
import { ScoreCollector } from "./scores.js";
import { UsageCollector } from "./usage.js";

/**
 * SUT handler signature. The second argument is a per-case usage/cost collector —
 * a handler that calls providers MUST record their cost through it. A handler that
 * records nothing yields zero recorded cost with an empty breakdown; that is lack
 * of measurement, not evidence that provider calls were free.
 */
export type SutHandler = (
  input: Record<string, unknown>,
  usage: UsageCollector,
  scores: ScoreCollector,
) => Promise<unknown>;
export type SutRegistry = Record<string, SutHandler>;

export interface EvalReport {
  results: CaseResult[];
  metrics: EvalMetrics;
  /** A/B/C hiring-challenge coverage, separate from the overall case tally. */
  challenge: ChallengeSummary;
  /** Whether provider cost was measured or is unmeasured because no provider call was recorded. */
  cost: CostSummary;
  /** Extraction measurements; mocked-provider runs are labelled as such. */
  extraction: ExtractionSummary;
  failures: number;
}

/** Load and schema-validate every *.json case in `dir`. Throws on any invalid case. */
export async function loadCases(dir: string): Promise<GoldenCase[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  const cases: GoldenCase[] = [];
  for (const file of files) {
    const raw: unknown = JSON.parse(await readFile(join(dir, file), "utf8"));
    const parsed = GoldenCaseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`golden case ${file} failed validation: ${parsed.error.message}`);
    }
    cases.push(parsed.data);
  }
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`duplicate golden case id: ${c.id}`);
    ids.add(c.id);
    if (c.noChangeTrap && !c.expect.some((a) => a.safety === true)) {
      throw new Error(`golden case ${c.id} sets noChangeTrap but declares no safety assertion`);
    }
  }
  return cases;
}

/** sha256 of each file under `dir`, keyed by forward-slash path relative to `dir`. Deterministic. */
export async function computeTreeHash(dir: string): Promise<Record<string, string>> {
  return computeTreeHashFrom(dir, dir);
}

/** `root` is the directory the caller asked about; every key is relative to it, so
 *  equal file names in different subtrees stay distinct instead of overwriting. */
async function computeTreeHashFrom(root: string, dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(out, await computeTreeHashFrom(root, abs));
      continue;
    }
    if (!entry.isFile()) continue;
    const hash = createHash("sha256").update(await readFile(abs)).digest("hex");
    out[relative(root, abs).replaceAll("\\", "/")] = hash;
  }
  return out;
}

export interface DriftResult {
  ok: boolean;
  mismatched: string[];
  missing: string[];
  added: string[];
}

export async function checkDrift(dir: string, lockFile: string): Promise<DriftResult> {
  let lock: { files: Record<string, string> };
  try {
    lock = JSON.parse(await readFile(lockFile, "utf8")) as { files: Record<string, string> };
  } catch {
    return { ok: false, mismatched: [], missing: [], added: ["<lock file missing or unreadable>"] };
  }
  const current = await computeTreeHash(dir);
  const lockFiles = lock.files ?? {};
  const mismatched = Object.keys(lockFiles).filter((k) => current[k] !== undefined && current[k] !== lockFiles[k]);
  const missing = Object.keys(lockFiles).filter((k) => current[k] === undefined);
  const added = Object.keys(current).filter((k) => lockFiles[k] === undefined);
  return { ok: mismatched.length === 0 && missing.length === 0 && added.length === 0, mismatched, missing, added };
}

export async function bless(dir: string, lockFile: string): Promise<void> {
  const files = await computeTreeHash(dir);
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(lockFile, JSON.stringify({ algorithm: "sha256", files: sorted }, null, 2) + "\n", "utf8");
}

const pendingLatency = 0;

async function runCase(c: GoldenCase, registry: SutRegistry): Promise<CaseResult> {
  const handler = c.sut ? registry[c.sut] : undefined;
  const base = {
    id: c.id,
    scenario: c.scenario,
    kind: c.kind,
    slice: c.slice,
    metrics: c.metrics,
    noChangeTrap: c.noChangeTrap,
    assertions: [],
    costUsd: 0,
    costBreakdown: [],
    scores: [],
  };
  if (!handler) {
    return {
      ...base,
      status: "pending",
      latencyMs: pendingLatency,
      summary: c.sut ? `SUT '${c.sut}' not registered (arrives in slice ${c.slice})` : `declarative case (arrives in slice ${c.slice})`,
    };
  }
  const t0 = performance.now();
  const usage = new UsageCollector();
  const scores = new ScoreCollector();
  try {
    const output = await handler(c.input ?? {}, usage, scores);
    const assertions = applyAssertions(output, c.expect);
    const latencyMs = performance.now() - t0;
    const failed = assertions.filter((a) => !a.pass);
    return {
      ...base,
      status: failed.length === 0 ? "pass" : "fail",
      latencyMs,
      assertions,
      costUsd: usage.totalUsd(),
      costBreakdown: usage.breakdown(),
      scores: scores.all(),
      summary: failed.length === 0 ? "ok" : `${failed.length}/${assertions.length} assertions failed: ${failed.map((a) => `${a.path} ${a.op}`).join(", ")}`,
    };
  } catch (err) {
    return {
      ...base,
      status: "fail",
      latencyMs: performance.now() - t0,
      error: err instanceof Error ? err.message : String(err),
      costUsd: usage.totalUsd(),
      costBreakdown: usage.breakdown(),
      scores: scores.all(),
      summary: `SUT threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function runCases(cases: GoldenCase[], registry: SutRegistry): Promise<EvalReport> {
  const results: CaseResult[] = [];
  for (const c of cases) results.push(await runCase(c, registry)); // deterministic, sequential — no shared state
  const metrics = computeMetrics(results);
  return {
    results,
    metrics,
    challenge: summarizeScenarios(results),
    cost: summarizeCost(results),
    extraction: summarizeExtractionScores(results),
    failures: metrics.failed,
  };
}

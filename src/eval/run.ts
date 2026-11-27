#!/usr/bin/env tsx
/**
 * Evaluation harness entry point (ADR-012).
 *   npm run eval            — run all golden cases; exits 1 on any failure, 2 on fixture drift
 *   npm run eval:bless      — re-pin fixture drift hashes after an intentional fixture change
 *   npm run eval -- --json  — machine-readable report on stdout
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { loadCases, runCases, checkDrift, bless, type EvalReport } from "./harness.js";
import { sutRegistry } from "./registry.js";

export interface EvalCliOptions {
  dir: string;
  lockFile: string;
  json: boolean;
  blessMode: boolean;
  /** drift check on by default; disable only for debugging (--no-drift-check). */
  driftCheck: boolean;
}

export function parseArgs(argv: string[], cwd: string = process.cwd()): EvalCliOptions {
  const opts: EvalCliOptions = {
    dir: join(cwd, "eval", "golden"),
    lockFile: join(cwd, "eval", "fixtures.lock.json"),
    json: false,
    blessMode: false,
    driftCheck: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--dir": opts.dir = argv[++i]!; break;
      case "--lock": opts.lockFile = argv[++i]!; break;
      case "--json": opts.json = true; break;
      case "--bless": opts.blessMode = true; break;
      case "--no-drift-check": opts.driftCheck = false; break;
      default: throw new Error(`unknown flag: ${arg}`);
    }
  }
  return opts;
}

export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  for (const r of report.results) {
    const mark = r.status === "pass" ? "PASS" : r.status === "fail" ? "FAIL" : "PEND";
    lines.push(`${mark}  ${r.id}  (${r.summary})`);
    if (r.status === "fail") {
      for (const a of r.assertions.filter((a) => !a.pass)) {
        lines.push(`      ✗ ${a.message ?? a.path}; actual=${JSON.stringify(a.actual)}`);
      }
    }
  }
  const m = report.metrics;
  const pct = (v: number | null) => (v === null ? "n/a (no executed cases)" : `${(v * 100).toFixed(1)}%`);
  const challenge = report.challenge;
  const challengeStatus = challenge.complete
    ? "COMPLETE"
    : challenge.scenarios.some((s) => s.status === "failing")
      ? "FAILING"
      : "INCOMPLETE";
  const runStatus = m.failed > 0 ? "FAILING" : m.pending > 0 ? "INCOMPLETE" : "COMPLETE";
  const evaluationComplete = runStatus === "COMPLETE" && challenge.complete;

  lines.push("");
  lines.push(`cases: ${m.total} total | executed=${m.executed} (pass=${m.passed}, fail=${m.failed}) | pending=${m.pending}`);
  lines.push(`historical recall correctness: ${pct(m.recallCorrectness)}`);
  lines.push(`temporal correctness:          ${pct(m.temporalCorrectness)}`);
  lines.push(`correction temporal correctness: ${pct(m.correctionTemporalCorrectness)}`);
  lines.push(`citation coverage:             ${pct(m.citationCoverage)}`);
  lines.push(`false-unchanged violations:    ${m.falseUnchangedViolations} (must be 0)`);
  lines.push(`false merges (critical):       ${m.falseMergeViolations} (must be 0)`);
  lines.push(`latency ms  p50=${m.latencyMs.p50.toFixed(1)}  p95=${m.latencyMs.p95.toFixed(1)}  max=${m.latencyMs.max.toFixed(1)}`);
  lines.push(
    report.cost.basis === "measured"
      ? `provider cost USD:             ${report.cost.totalUsd.toFixed(6)} (measured from ${report.cost.providerCalls} provider call(s) across ${report.cost.casesWithProviderCalls} executed case(s))`
      : "provider cost:                 NOT MEASURED — 0 provider calls recorded; zero is not a measured provider cost",
  );

  const ex = report.extraction;
  const score = (s: { mean: number | null; cases: number }) =>
    s.mean === null ? "n/a (no case recorded it)" : `${(s.mean * 100).toFixed(1)}% (n=${s.cases})`;
  lines.push("");
  lines.push(
    `extraction runs:                ${ex.executedCases} scored case(s); provider basis ${ex.providerBasis.toUpperCase()}; ` +
    `semantic quality ${ex.semanticQuality.replace("_", " ").toUpperCase()}`,
  );
  lines.push(`  extraction precision:          ${score(ex.scores.precision)}`);
  lines.push(`  extraction recall:             ${score(ex.scores.recall)}`);
  lines.push(`  provenance validity:           ${score(ex.scores.provenance)}`);
  lines.push(`  negation/modality preserved:   ${score(ex.scores.negationModality)}`);
  lines.push(`  unsupported assertion rate:    ${score(ex.scores.unsupportedAssertionRate)}`);
  lines.push(`  duplicate-on-retry rate:       ${score(ex.scores.duplicateOnRetryRate)}`);
  lines.push("");
  lines.push("challenge scenarios (A/B/C):");
  for (const s of challenge.scenarios) {
    lines.push(
      `  ${s.id}  ${s.status.toUpperCase().padEnd(15)} executed ${s.executed}/${s.total}  pass ${s.passed}  fail ${s.failed}  pending ${s.pending}`,
    );
  }
  lines.push(
    `challenge completion: ${challengeStatus} — cases ${challenge.executedCases}/${challenge.totalCases} executed; ` +
    `scenarios complete ${challenge.completeScenarios}/${challenge.totalScenarios}, ` +
    `executable ${challenge.executableScenarios}/${challenge.totalScenarios}, ` +
    `fully executable ${challenge.fullyExecutableScenarios}/${challenge.totalScenarios}`,
  );
  lines.push(
    `run status: ${runStatus} — ${m.executed}/${m.total} cases executed, ${m.pending} pending, ${m.failed} failed` +
    (evaluationComplete ? "" : "; this is NOT a complete hiring-challenge evaluation"),
  );
  return lines.join("\n");
}

export async function runEval(opts: EvalCliOptions): Promise<{ report?: EvalReport; exitCode: number; output: string }> {
  if (opts.blessMode) {
    await bless(opts.dir, opts.lockFile);
    return { exitCode: 0, output: `blessed fixtures in ${opts.dir} -> ${opts.lockFile}` };
  }
  if (opts.driftCheck) {
    const drift = await checkDrift(opts.dir, opts.lockFile);
    if (!drift.ok) {
      const detail = [
        ...drift.mismatched.map((f) => `changed: ${f}`),
        ...drift.missing.map((f) => `missing: ${f}`),
        ...drift.added.map((f) => `added:   ${f}`),
      ].join("\n  ");
      return { exitCode: 2, output: `fixture drift detected — re-run with --bless only if the fixture change was intentional:\n  ${detail}` };
    }
  }
  const cases = await loadCases(opts.dir);
  const report = await runCases(cases, sutRegistry);
  const output = opts.json ? JSON.stringify(report, null, 2) : formatReport(report);
  return { report, exitCode: report.failures > 0 ? 1 : 0, output };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { exitCode, output } = await runEval(parseArgs(argv));
  console.log(output);
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  });
}

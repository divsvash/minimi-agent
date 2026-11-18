import type { GoldenAssertion } from "./goldenCase.js";

export interface AssertionResult extends GoldenAssertion {
  actual: unknown;
  pass: boolean;
  message?: string;
}

/** Resolve a dot path like "episodes.0.text" against a JSON value. */
export function resolvePath(root: unknown, path: string): { found: boolean; value: unknown } {
  let cur: unknown = root;
  for (const seg of path.split(".")) {
    if (cur === null || cur === undefined) return { found: false, value: undefined };
    if (typeof cur !== "object") return { found: false, value: undefined };
    const idx = Number.isInteger(Number(seg)) && Array.isArray(cur) ? Number(seg) : seg;
    if (!Object.prototype.hasOwnProperty.call(cur, idx as keyof typeof cur) && !(Array.isArray(cur) && typeof idx === "number")) {
      return { found: false, value: undefined };
    }
    cur = (cur as Record<string, unknown>)[idx as string];
  }
  return { found: true, value: cur };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, (b as unknown[])[i]));
  }
  if (a && b && typeof a === "object") {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

export function applyAssertion(output: unknown, assertion: GoldenAssertion): AssertionResult {
  const { path, op, value, description } = assertion;
  const { found, value: actual } = resolvePath(output, path);
  const base = { ...assertion, actual, pass: false };
  const fmt = (v: unknown) => JSON.stringify(v) ?? String(v);

  switch (op) {
    case "eq":
      return { ...base, pass: found && deepEqual(actual, value), message: `expected ${path} = ${fmt(value)}` };
    case "neq":
      return { ...base, pass: found && !deepEqual(actual, value), message: `expected ${path} != ${fmt(value)}` };
    case "oneOf": {
      const options = Array.isArray(value) ? value : [];
      return { ...base, pass: found && options.some((o) => deepEqual(actual, o)), message: `expected ${path} ∈ ${fmt(options)}` };
    }
    case "includes": {
      const pass =
        found &&
        ((typeof actual === "string" && typeof value === "string" && actual.includes(value)) ||
          (Array.isArray(actual) && actual.some((a) => deepEqual(a, value))));
      return { ...base, pass, message: `expected ${path} to include ${fmt(value)}` };
    }
    case "length":
      return {
        ...base,
        pass: found && typeof value === "number" && ((actual as unknown[])?.length ?? -1) === value,
        message: `expected length(${path}) = ${fmt(value)}`,
      };
    case "gte":
      return { ...base, pass: found && typeof actual === "number" && typeof value === "number" && actual >= value, message: `expected ${path} >= ${fmt(value)}` };
    case "lte":
      return { ...base, pass: found && typeof actual === "number" && typeof value === "number" && actual <= value, message: `expected ${path} <= ${fmt(value)}` };
    case "exists":
      return { ...base, pass: found && actual !== undefined, message: `expected ${path} to exist` };
    default: {
      const exhaustive: never = op;
      return { ...base, pass: false, message: `unknown op ${String(exhaustive)}` };
    }
  }
}

export function applyAssertions(output: unknown, assertions: GoldenAssertion[]): AssertionResult[] {
  return assertions.map((a) => applyAssertion(output, a));
}

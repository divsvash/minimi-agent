import type { LifecycleEvent, Statement } from "../contracts/schemas.js";

/**
 * `Statement.status` is a cache derived from immutable lifecycle events
 * (ADR-004). This is the single projection implementation: it computes both
 * the current state and the state as of a transaction-time instant, without
 * ever editing a statement.
 */
export function projectStatus(
  statementId: string,
  events: readonly LifecycleEvent[],
  asOfTx?: Date | null,
): Statement["status"] {
  const cutoff = asOfTx ? asOfTx.getTime() : null;
  const relevant = events.filter(
    (event) => event.targetId === statementId && (cutoff === null || new Date(event.at).getTime() <= cutoff),
  );
  if (relevant.some((event) => event.kind === "retracted")) return "retracted";
  if (relevant.some((event) => event.kind === "superseded")) return "superseded";
  if (relevant.some((event) => event.kind === "conflicted" || event.kind === "resolution_contested")) {
    return "conflicted";
  }
  return "active";
}

/** Conflicting assertions stay visible — a conflict is surfaced, not resolved. */
export function visibleAt(
  statementId: string,
  events: readonly LifecycleEvent[],
  asOfTx?: Date | null,
): boolean {
  const status = projectStatus(statementId, events, asOfTx);
  return status === "active" || status === "conflicted";
}

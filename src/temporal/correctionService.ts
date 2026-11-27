import { systemClock, type Clock } from "../core/clock.js";
import { NotFoundError, ValidationError } from "../core/errors.js";
import { ids } from "../core/ids.js";
import type { LifecycleStore, StatementStore, StatementWrite } from "../contracts/ports.js";
import type { CorrectionPlan, CorrectionResult, LifecycleEvent } from "../contracts/schemas.js";
import { validateStatementWrite } from "../memory/validateStatementWrite.js";
import { statementContentHash } from "../memory/statementContent.js";

/**
 * Deterministic correction logic (ADR-004). It never asks a model to decide
 * identity or truth: the caller must name the target and its immutable
 * fingerprint. Ambiguous or stale targets are rejected, never guessed.
 */
export class CorrectionService<TX extends object> {
  private readonly clock: Clock;

  constructor(
    private readonly statements: StatementStore<TX>,
    private readonly lifecycle: LifecycleStore<TX>,
    options: { clock?: Clock } = {},
  ) {
    this.clock = options.clock ?? systemClock;
  }

  private planHash(plan: CorrectionPlan): string {
    const parts = plan.kind === "conflict"
      ? [plan.kind, plan.targetId, plan.otherId, plan.expectedFingerprint, plan.otherFingerprint, plan.reason, plan.actor]
      : plan.kind === "supersede"
        ? [plan.kind, plan.targetId, plan.expectedFingerprint, statementContentHash(validateStatementWrite(plan.replacement as StatementWrite).statement), plan.reason, plan.actor]
        : [plan.kind, plan.targetId, plan.expectedFingerprint, plan.reason, plan.actor];
    return ids.sha256(JSON.stringify(parts));
  }

  async correct(
    tx: TX,
    raw: CorrectionPlan,
    context: { jobId?: string; claimGeneration?: number } = {},
  ): Promise<CorrectionResult> {
    const plan = raw;
    const target = await this.statements.byId(plan.targetId);
    if (!target) throw new NotFoundError(`correction target ${plan.targetId} does not exist`);
    if (statementContentHash(target) !== plan.expectedFingerprint) {
      throw new ValidationError("correction target no longer matches its expected immutable content");
    }
    if (plan.kind === "conflict" && plan.targetId === plan.otherId) {
      throw new ValidationError("a statement cannot conflict with itself");
    }

    const planHash = this.planHash(plan);
    const recordedAt = this.clock.now().toISOString();
    const eventId = (suffix = "") =>
      `lc:${ids.sha256([planHash, plan.targetId, suffix].join("|"))}`;

    if (plan.kind === "supersede") {
      const id = eventId("superseded");
      const existing = await this.lifecycle.event(id);
      if (existing) return this.result(plan, planHash, recordedAt, "already_applied", [existing]);
      const write = validateStatementWrite(plan.replacement as StatementWrite);
      if (write.statement.id === plan.targetId) {
        throw new ValidationError("a superseding statement must be a new statement");
      }
      const replacement = await this.statements.insert(tx, write);
      const event: LifecycleEvent = {
        id, kind: "superseded", targetId: plan.targetId, replacementId: replacement.id,
        at: recordedAt, actor: plan.actor, reason: plan.reason, ...context, planHash,
      };
      await this.lifecycle.putEvent(tx, event);
      return this.result(plan, planHash, recordedAt, "applied", [event]);
    }

    if (plan.kind === "retract") {
      const id = eventId("retracted");
      const existing = await this.lifecycle.event(id);
      if (existing) return this.result(plan, planHash, recordedAt, "already_applied", [existing]);
      const event: LifecycleEvent = {
        id, kind: "retracted", targetId: plan.targetId,
        at: recordedAt, actor: plan.actor, reason: plan.reason, ...context, planHash,
      };
      await this.lifecycle.putEvent(tx, event);
      return this.result(plan, planHash, recordedAt, "applied", [event]);
    }

    const other = await this.statements.byId(plan.otherId);
    if (!other) throw new NotFoundError(`conflicting statement ${plan.otherId} does not exist`);
    if (statementContentHash(other) !== plan.otherFingerprint) {
      throw new ValidationError("the second conflicting statement does not match its expected immutable content");
    }
    const firstId = eventId("conflicted-target");
    const secondId = ids.sha256([planHash, plan.otherId, "conflicted-other"].join("|"));
    const existing = await this.lifecycle.event(firstId);
    if (existing) return this.result(plan, planHash, recordedAt, "already_applied", [existing]);
    const events: LifecycleEvent[] = [
      {
        id: firstId, kind: "conflicted", targetId: plan.targetId, otherId: plan.otherId,
        at: recordedAt, actor: plan.actor, reason: plan.reason, ...context, planHash,
      },
      {
        id: `lc:${secondId}`, kind: "conflicted", targetId: plan.otherId, otherId: plan.targetId,
        at: recordedAt, actor: plan.actor, reason: plan.reason, ...context, planHash,
      },
    ];
    for (const event of events) await this.lifecycle.putEvent(tx, event);
    return this.result(plan, planHash, recordedAt, "applied", events);
  }

  private result(
    plan: CorrectionPlan,
    planHash: string,
    recordedAt: string,
    status: "applied" | "already_applied",
    events: LifecycleEvent[],
  ): CorrectionResult {
    return {
      kind: plan.kind,
      status,
      eventIds: events.map((e) => e.id),
      targetId: plan.targetId,
      replacementId: plan.kind === "supersede" ? events[0]?.replacementId : undefined,
      otherId: plan.kind === "conflict" ? plan.otherId : undefined,
      planHash,
      recordedAt: events[0]?.at ?? recordedAt,
    };
  }
}

import { systemClock, type Clock } from "../core/clock.js";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors.js";
import { ids } from "../core/ids.js";
import type { EmbeddingProvider, ResolutionStore } from "../contracts/ports.js";
import {
  MergePlanSchema, SplitPlanSchema,
  type MergeEvent, type MergePlan, type ResolutionDecision, type ResolutionRequest,
  type SplitEvent, type SplitPlan,
} from "../contracts/schemas.js";
import { generateCandidates, normalizeName } from "./candidates.js";
import { decide } from "./policy.js";

/**
 * Slice 4 service. `resolve` only ranks and decides; it never writes identity.
 * `merge`/`split` are the only durable identity operations, they require explicit
 * authorization, and they run inside the caller's fenced transaction.
 */
export class EntityResolutionService<TX extends object> {
  private readonly clock: Clock;
  private readonly embeddings?: EmbeddingProvider;

  constructor(
    private readonly store: ResolutionStore<TX>,
    options: { clock?: Clock; embeddings?: EmbeddingProvider } = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.embeddings = options.embeddings;
  }

  async resolve(request: ResolutionRequest): Promise<ResolutionDecision> {
    const entities = await this.store.entities();
    const candidates = await generateCandidates({
      request,
      entities,
      embeddings: this.embeddings,
    });
    return decide(request, candidates);
  }

  async merge(tx: TX, raw: MergePlan): Promise<MergeEvent> {
    const plan = MergePlanSchema.parse(raw);
    if (plan.sourceId === plan.targetId) {
      throw new ValidationError("a merge source and target must be different entities");
    }
    const planHash = ids.sha256(JSON.stringify(plan));
    const eventId = `mge:${ids.sha256(JSON.stringify([plan.sourceId, plan.targetId, plan.authorization, plan.aliases, plan.reason]))}`;

    const existing = await this.store.mergeEvent(eventId);
    if (existing) return existing; // identical retry

    const source = await this.store.entityById(plan.sourceId);
    const target = await this.store.entityById(plan.targetId);
    if (!source || !target) throw new NotFoundError("merge source or target entity does not exist");

    const edges = await this.store.mergeEdges();
    const outgoing = edges.find((e) => e.from === source.id);
    if (outgoing) {
      if (outgoing.to === target.id) throw new ConflictError("merge was already applied with different details");
      throw new ConflictError(`entity ${source.id} is already merged into ${outgoing.to}`);
    }

    // Cycle guard: following MERGED_INTO from the target must never reach the source.
    const adjacency = new Map<string, string[]>();
    for (const edge of edges) adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
    const seen = new Set<string>();
    const stack = [target.id];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === source.id) throw new ConflictError("merge would create a MERGED_INTO cycle");
      if (seen.has(current)) continue;
      seen.add(current);
      stack.push(...(adjacency.get(current) ?? []));
    }

    for (const alias of plan.aliases) {
      if (!source.aliases.includes(alias) && source.canonicalName !== alias) {
        throw new ValidationError(`alias '${alias}' is not owned by the merge source`);
      }
    }

    const event: MergeEvent = {
      id: eventId,
      kind: "merge",
      sourceId: source.id,
      targetId: target.id,
      aliases: [...plan.aliases],
      authorization: plan.authorization,
      reason: plan.reason,
      planHash,
      recordedAt: this.clock.now().toISOString(),
    };
    await this.store.putMerge(tx, event, source.id, target);
    return event;
  }

  async split(tx: TX, raw: SplitPlan): Promise<SplitEvent> {
    const plan = SplitPlanSchema.parse(raw);
    if (plan.statementIds.length === 0 && plan.evidenceIds.length === 0 && plan.aliases.length === 0) {
      throw new ValidationError("a split requires an explicit reassignment plan; nothing was selected");
    }
    if (new Set(plan.statementIds).size !== plan.statementIds.length
      || new Set(plan.evidenceIds).size !== plan.evidenceIds.length
      || new Set(plan.aliases).size !== plan.aliases.length) {
      throw new ValidationError("a split plan contains duplicate instructions");
    }

    const planHash = ids.sha256(JSON.stringify(plan));
    const newEntityId = plan.newEntityId
      ?? `ent:${ids.sha256(["split", plan.sourceId, normalizeName(plan.canonicalName), plan.type, planHash].join("|"))}`;
    if (newEntityId === plan.sourceId) {
      throw new ValidationError("a split cannot designate its source as the new entity");
    }
    const eventId = `spe:${ids.sha256(JSON.stringify([plan.sourceId, newEntityId, plan.statementIds, plan.evidenceIds, plan.aliases, plan.authorization, plan.reason]))}`;

    const existing = await this.store.splitEvent(eventId);
    if (existing) return existing; // identical retry

    const source = await this.store.entityById(plan.sourceId);
    if (!source) throw new NotFoundError(`split source entity ${plan.sourceId} does not exist`);
    if (await this.store.entityById(newEntityId)) {
      throw new ConflictError(`split target entity ${newEntityId} already exists`);
    }

    const availableStatements = await this.store.statementIdsForEntity(source.id);
    const unknownStatements = plan.statementIds.filter((id) => !availableStatements.includes(id));
    if (unknownStatements.length > 0) {
      throw new ValidationError(`split plan names statements not attached to ${source.id}: ${unknownStatements.join(", ")}`);
    }
    const availableEvidence = await this.store.evidenceIdsForStatements(plan.statementIds);
    const unknownEvidence = plan.evidenceIds.filter((id) => !availableEvidence.includes(id));
    if (unknownEvidence.length > 0) {
      throw new ValidationError(`split plan names evidence not attached to the selected statements: ${unknownEvidence.join(", ")}`);
    }
    const unknownAliases = plan.aliases.filter((alias) => !source.aliases.includes(alias));
    if (unknownAliases.length > 0) {
      throw new ValidationError(`split plan names aliases not owned by ${source.id}: ${unknownAliases.join(", ")}`);
    }

    const recordedAt = this.clock.now().toISOString();
    const event: SplitEvent = {
      id: eventId,
      kind: "split",
      sourceId: source.id,
      newEntityId,
      statementIds: [...plan.statementIds],
      evidenceIds: [...plan.evidenceIds],
      aliases: [...plan.aliases],
      authorization: plan.authorization,
      reason: plan.reason,
      planHash,
      recordedAt,
    };
    await this.store.putSplit(tx, event, source, {
      id: newEntityId,
      type: plan.type,
      canonicalName: plan.canonicalName,
      aliases: [...plan.aliases],
      status: "active",
      createdAt: recordedAt,
      updatedAt: recordedAt,
    });
    return event;
  }
}

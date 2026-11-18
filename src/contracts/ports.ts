/**
 * Domain-responsibility contracts (ports). No implementations live here — and none
 * should be invented for components that have not been built in an earlier slice.
 * Each interface is shaped around actual domain responsibilities (docs/architecture.md),
 * not around "a generic repository".
 *
 * Neo4j remains the authoritative store (ADR-001). These interfaces are seams for
 * tests and offline evaluation, not abstraction for its own sake.
 */
import type {
  Entity, EntityType, Episode, EpisodeRole, Job, Observation, Statement,
} from "./schemas.js";

export interface EpisodeStore {
  byId(id: string): Promise<Episode | null>;
  /** Half-open [from, to) UTC range; Episode.occurredAt is always UTC.
   *  `from` MUST precede `to`. An invalid range (from >= to) is NOT an error —
   *  it yields an empty result, consistent with the Neo4j implementation
   *  (a `>= from AND occurredAt < to` predicate can match nothing). */
  byOccurredRange(from: Date, to: Date, role?: EpisodeRole): Promise<Episode[]>;
  /** Synchronous-with-writes full-text search (ADR-011). */
  search(text: string): Promise<Episode[]>;
  /** Episodes with no completed extract job — reconciliation input, never crash recovery (ADR-010). */
  withoutCompletedExtraction(olderThan: Date): Promise<Episode[]>;
}

export interface EnqueueOptions {
  maxAttempts?: number;
  nextRunAt?: Date;
}

/**
 * Fenced job ledger (ADR-010). `TX` is the store-transaction handle: Neo4j binds it
 * to ManagedTransaction; fakes bind it to an in-memory context.
 *
 * TX is a SINGLE-USE, OPAQUE CAPABILITY, not a general store handle:
 *   - valid only for the duration of the commitFencedOutput callback;
 *   - must not be stored, captured for later use, or used after the callback settles —
 *     stores must reject such use (Neo4j does: the transaction is closed and every
 *     statement fails). A TX that outlives its callback is not a fence and voids the
 *     exactly-one-winner guarantee;
 *   - it exists so durable outputs commit inside the SAME transaction that re-validates
 *     (status, claimGeneration, lease) — it grants no capability the fence does not
 *     already cover, and callers get no other route from it back to the store.
 * All durable outputs commit only inside a transaction re-validating (status, claimGeneration, lease) —
 * callers cannot bypass the fence through this interface.
 */
export interface JobRepository<TX extends object = object> {
  enqueue(kind: string, payload: unknown, idempotencyKey: string, opts?: EnqueueOptions): Promise<string>;
  claimNext(workerId: string): Promise<Job | null>;
  renewLease(jobId: string, claimGeneration: number, workerId: string): Promise<boolean>;
  commitFencedOutput<T>(
    jobId: string,
    claimGeneration: number,
    workerId: string,
    write: (tx: TX) => Promise<T>,
  ): Promise<T>;
  complete(jobId: string, claimGeneration: number, workerId: string): Promise<boolean>;
  fail(jobId: string, claimGeneration: number, workerId: string, error: string): Promise<"requeued" | "dead" | "rejected">;
  sweep(): Promise<{ requeued: number; provisionalsReaped: number }>;
  deadJobs(): Promise<Job[]>;
  redrive(jobId: string): Promise<void>;
}

/** Two as-of axes, always named explicitly (§4). Omitted axis = unconstrained on that axis. */
export interface ActiveAtFilter {
  /** State of the world at this instant (valid time). */
  asOfValid?: Date | null;
  /** What was recorded/believed at this instant (transaction time). */
  asOfTx?: Date | null;
  subjectId?: string;
  predicate?: string;
  modality?: Statement["modality"];
}

export interface StatementStore {
  byId(id: string): Promise<Statement | null>;
  forSubject(subjectId: string): Promise<Statement[]>;
  /**
   * The ONLY place interval semantics are implemented (§4): open intervals, null
   * validFrom (unknown start — never epoch/now), and transaction-time via the
   * lifecycle event log are all resolved inside this call, not by callers.
   */
  activeAt(filter: ActiveAtFilter): Promise<Statement[]>;
  /** Append-only write; corrections are new statements + lifecycle events, never mutation (ADR-004). */
  insert(statement: Omit<Statement, "status">): Promise<Statement>;
}

export interface ObservationStore {
  latestFor(subjectId: string, attribute: string, dimensions?: Record<string, string>): Promise<Observation | null>;
  /** Full supersession chain for one (subject, attribute), oldest first. */
  history(subjectId: string, attribute: string): Promise<Observation[]>;
  /** Insert a new observation; Supersession via SUPERSEDED_BY relationships, never mutation (ADR-005). */
  insertObservation(observation: Observation, subjectId: string, supersededBy?: { previousId: string; detectedAt: Date; researchRunId: string; reason: string }): Promise<void>;
  /** One Capture per fetch attempt, always — including failures (§3.5). */
  recordCapture(capture: import("./schemas.js").Capture, observedObservationId?: string): Promise<void>;
}

export type EntityCandidate = {
  entityId: string;
  /** Candidate-generation score; similarity alone NEVER authorizes a merge (ADR-006). */
  score: number;
  reason: string;
};

export type ResolutionDecision =
  | { kind: "link"; entityId: string; candidates: EntityCandidate[]; rationale: string }
  | { kind: "create"; candidates: EntityCandidate[]; rationale: string }
  | { kind: "review"; candidates: EntityCandidate[]; rationale: string };

export interface EntityResolver {
  resolve(mention: { name: string; type?: EntityType; context?: string }): Promise<ResolutionDecision>;
}

export interface RetrievalQuery {
  text: string;
  asOfValid?: Date | null;
  asOfTx?: Date | null;
  entities?: string[];
  predicates?: string[];
  hops?: number; // clamped to 2 by implementations (§5.1)
  limit?: number;
}

export interface EvidenceBundle {
  statements: Statement[];
  episodes: Episode[];
  entities: Entity[];
  scores: { id: string; vector: number | null; fulltext: number | null; graph: number | null; rrf: number }[];
  planHash: string;
}

export interface Retriever {
  /** As-of filter is injected by the store layer for every leg; callers cannot forget it (§5.2). */
  retrieve(query: RetrievalQuery): Promise<EvidenceBundle>;
}

export type ResearchAttempt = {
  query?: string;
  url?: string;
  sourceId?: string;
  outcome: "ok" | "http_error" | "timeout" | "parse_error" | "blocked";
  relevant?: boolean;
  accessible?: boolean;
  attributeExtracted?: boolean;
  dimsComparable?: boolean | null;
  value?: string | number | boolean | null;
  sourceEffectiveAt?: string | null;
  sourcePublishedAt?: string | null;
  authoritative?: boolean;
  fresh?: boolean;
  conflictWith?: string | null;
};

export type Verdict = "insufficient_evidence" | "changed" | "verified_unchanged" | "no_change_found";
export type NoChangeReason =
  | "stale_source" | "source_not_authoritative" | "dimension_mismatch"
  | "attribute_not_extracted" | "no_relevant_source" | "conflicting_unresolved";

export interface ResearchRun {
  id: string;
  entity: string;
  attribute: string;
  dimensions: Record<string, string>;
  queries: string[];
  startedAt: string;
  completedAt?: string;
  attempts: ResearchAttempt[];
}

export interface ResearchOutcome {
  run: ResearchRun;
  verdict: Verdict;
  /** Mandatory when verdict === "no_change_found" (§6.4). */
  reason?: NoChangeReason;
  baseline?: Observation | null;
  current?: Observation | null;
}

/** ResearchProvider ships data shapes only. Verdict-rule correctness
 *  (comparability, authority, freshness, conflicts) is specified and tested in
 *  slice 7's verdict engine — NOT by the fake fixtures in src/fakes/research.ts. */
export interface ResearchProvider {
  /** Captures an observation (or records why it could not). Never auto-rewrites claims (ADR-009). */
  observe(request: {
    entity: { id?: string; name: string; type?: EntityType };
    attribute: string;
    dimensions?: Record<string, string>;
    baseline?: Observation | null;
  }): Promise<ResearchOutcome>;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LLMRequest {
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  maxTokens?: number;
  temperature?: number;
  model?: string;
}

export interface LLMResponse {
  text: string;
  model: string;
  usage: LLMUsage;
  finishReason?: string;
}

export interface LLMProvider {
  complete(request: LLMRequest): Promise<LLMResponse>;
}

export interface EmbeddingProvider {
  /** Model identifier the vectors were produced with — stored alongside every embedding (§3.4). */
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export type { Clock } from "../core/clock.js";
export type { IdGenerator } from "../core/idGenerator.js";

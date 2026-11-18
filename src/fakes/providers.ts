import { ProviderError, ProviderTimeoutError, ProviderUnavailableError } from "../core/errors.js";
import type { EmbeddingProvider, LLMProvider, LLMRequest, LLMResponse, LLMUsage } from "../contracts/ports.js";
import { createHash } from "node:crypto";

/** Pinned fake-model price table (USD per million tokens). Recorded in eval output (§10). */
export const FAKE_LLM_PRICE = { model: "fake-llm-1", inputPerMTok: 0.1, outputPerMTok: 0.4 } as const;
export const FAKE_EMBED_PRICE = { model: "fake-embed-1", inputPerMTok: 0.02 } as const;

export function llmCostUsd(model: string, usage: LLMUsage): number {
  const p = model === FAKE_LLM_PRICE.model ? FAKE_LLM_PRICE : { inputPerMTok: 0, outputPerMTok: 0 };
  return (usage.inputTokens * p.inputPerMTok + usage.outputTokens * p.outputPerMTok) / 1_000_000;
}

export type FakeLLMHandler = (req: LLMRequest) => LLMResponse | Promise<LLMResponse>;

/**
 * Deterministic in-memory LLM fake.
 * - No network, no timers. Responses come from a scripted handler or a response queue.
 * - Failure injection: failNext(n) / timeoutNext(n) / unavailableNext(n).
 * - Every request is recorded; cost is accumulated from a pinned price table.
 * - "Conflicting responses" are scripted by branching on req.messages content.
 */
export class FakeLLMProvider implements LLMProvider {
  readonly requests: LLMRequest[] = [];
  private queue: (LLMResponse | Error)[] = [];
  private failures = { error: 0, timeout: 0, unavailable: 0 };
  private handler: FakeLLMHandler;

  constructor(handler?: FakeLLMHandler, private readonly defaultModel: string = FAKE_LLM_PRICE.model) {
    this.handler =
      handler ??
      ((req) => ({
        text: `fake-llm-response:${req.messages.at(-1)?.content ?? ""}`,
        model: this.defaultModel,
        usage: { inputTokens: 10, outputTokens: 5 },
        finishReason: "stop",
      }));
  }

  /** Push canned responses/errors; consumed FIFO before the handler is consulted. */
  enqueue(...items: (LLMResponse | Error)[]): this {
    this.queue.push(...items);
    return this;
  }
  failNext(n = 1): this {
    this.failures.error += n;
    return this;
  }
  timeoutNext(n = 1): this {
    this.failures.timeout += n;
    return this;
  }
  unavailableNext(n = 1): this {
    this.failures.unavailable += n;
    return this;
  }

  get callCount(): number {
    return this.requests.length;
  }
  private readonly usageLog: { model: string; usage: LLMUsage }[] = [];
  costUsd(): number {
    return this.usageLog.reduce((sum, e) => sum + llmCostUsd(e.model, e.usage), 0);
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(structuredClone(request));
    if (this.failures.timeout > 0) {
      this.failures.timeout -= 1;
      throw new ProviderTimeoutError("fake llm: scripted timeout");
    }
    if (this.failures.unavailable > 0) {
      this.failures.unavailable -= 1;
      throw new ProviderUnavailableError("fake llm: scripted unavailable");
    }
    if (this.failures.error > 0) {
      this.failures.error -= 1;
      throw new ProviderError("fake llm: scripted failure", true);
    }
    const queued = this.queue.shift();
    if (queued instanceof Error) throw queued;
    if (queued !== undefined) {
      this.usageLog.push({ model: queued.model, usage: queued.usage });
      return queued;
    }
    const res = await this.handler(request);
    this.usageLog.push({ model: res.model, usage: res.usage });
    return res;
  }

  reset(): void {
    this.requests.length = 0;
    this.usageLog.length = 0;
    this.queue.length = 0;
    this.failures = { error: 0, timeout: 0, unavailable: 0 };
  }
}

/**
 * Deterministic embedding fake: vector derived from sha256 of the input text.
 * Not semantically meaningful — it is stable and collision-free enough for tests,
 * which is all offline evaluation requires.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly calls: string[][] = [];
  private failures = { error: 0, timeout: 0 };
  private readonly dim: number;

  constructor(model: string = FAKE_EMBED_PRICE.model, dim = 16) {
    this.model = model;
    this.dim = dim;
  }

  failNext(n = 1): this {
    this.failures.error += n;
    return this;
  }
  timeoutNext(n = 1): this {
    this.failures.timeout += n;
    return this;
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push([...texts]);
    if (this.failures.timeout > 0) {
      this.failures.timeout -= 1;
      throw new ProviderTimeoutError("fake embeddings: scripted timeout");
    }
    if (this.failures.error > 0) {
      this.failures.error -= 1;
      throw new ProviderError("fake embeddings: scripted failure", true);
    }
    return texts.map((t) => this.vectorFor(t));
  }

  private vectorFor(text: string): number[] {
    const digest = createHash("sha256").update(text, "utf8").digest();
    const out: number[] = [];
    for (let i = 0; i < this.dim; i++) {
      // 4-byte window per dimension, folded to a signed unit float
      const b = digest[(i * 4) % digest.length]!;
      out.push((b - 128) / 128);
    }
    return out;
  }

  costUsd(): number {
    const tokens = this.calls.flat().reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);
    return (tokens * FAKE_EMBED_PRICE.inputPerMTok) / 1_000_000;
  }

  reset(): void {
    this.calls.length = 0;
    this.failures = { error: 0, timeout: 0 };
  }
}

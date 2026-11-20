import { systemClock, type Clock } from "../core/clock.js";
import { ProviderError, ProviderTimeoutError, ValidationError } from "../core/errors.js";
import { ExtractResultSchema, type Episode } from "../contracts/schemas.js";
import type { LLMProvider, LLMResponse, StatementWrite } from "../contracts/ports.js";
import {
  EXTRACTION_PROMPT_HASH, EXTRACTION_PROMPT_VERSION, buildExtractionMessages,
} from "./prompt.js";
import {
  EXTRACTION_SCHEMA_VERSION, validateCandidates, type RejectedCandidate,
} from "./validate.js";

export interface ExtractionServiceOptions {
  provider: LLMProvider;
  /** Optional configured model id; the response's model id is what gets recorded. */
  model?: string;
  /** Per-provider-call deadline. 0 disables the local deadline (tests only). */
  timeoutMs?: number;
  /** Retryable provider failures are retried this many times in total. */
  maxProviderAttempts?: number;
  clock?: Clock;
}

export interface ExtractionResult {
  episodeId: string;
  extractionModel: string;
  extractionPromptHash: string;
  extractionVersion: string;
  accepted: StatementWrite[];
  rejected: RejectedCandidate[];
  duplicateCandidates: number;
  providerCalls: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProviderTimeoutError(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const firstNewline = trimmed.indexOf("\n");
  if (firstNewline < 0) return trimmed;
  const body = trimmed.slice(firstNewline + 1);
  const end = body.lastIndexOf("```");
  return (end >= 0 ? body.slice(0, end) : body).trim();
}

export function parseExtractionResponse(text: string): ReturnType<typeof ExtractResultSchema.parse> {
  let raw: unknown;
  try {
    raw = JSON.parse(stripCodeFence(text));
  } catch (err) {
    throw new ValidationError("extraction response is not valid JSON", {
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  const parsed = ExtractResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError("extraction response failed schema validation", parsed.error.issues);
  }
  return parsed.data;
}

export class ExtractionService {
  private readonly provider: LLMProvider;
  private readonly model?: string;
  private readonly timeoutMs: number;
  private readonly maxProviderAttempts: number;
  private readonly clock: Clock;

  constructor(options: ExtractionServiceOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxProviderAttempts = Math.max(1, options.maxProviderAttempts ?? 2);
    this.clock = options.clock ?? systemClock;
  }

  private async complete(episode: Episode): Promise<{ response: LLMResponse; attempts: number }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxProviderAttempts; attempt++) {
      try {
        const response = await withTimeout(
          this.provider.complete({
            messages: buildExtractionMessages(episode),
            model: this.model,
            temperature: 0,
            maxTokens: 2000,
          }),
          this.timeoutMs,
          "extraction provider call",
        );
        return { response, attempts: attempt };
      } catch (err) {
        lastError = err;
        const retryable = err instanceof ProviderError && err.retryable;
        if (!retryable || attempt >= this.maxProviderAttempts) throw err;
      }
    }
    throw lastError instanceof Error ? lastError : new ProviderError("extraction provider failed");
  }

  async extractEpisode(episode: Episode): Promise<ExtractionResult> {
    const { response, attempts } = await this.complete(episode);
    const parsed = parseExtractionResponse(response.text);
    const recordedAt = this.clock.now().toISOString();
    const extractionVersion = `${response.model}|${EXTRACTION_PROMPT_VERSION}|${EXTRACTION_PROMPT_HASH}|${EXTRACTION_SCHEMA_VERSION}`;
    const mapped = validateCandidates({
      episode,
      candidates: parsed.candidates,
      extractionModel: response.model,
      extractionPromptHash: EXTRACTION_PROMPT_HASH,
      extractionVersion,
      recordedAt,
    });

    if (mapped.accepted.length === 0 && mapped.rejected.length > 0) {
      throw new ValidationError(
        `all ${mapped.rejected.length} extracted candidate(s) failed validation`,
        mapped.rejected.map((r) => ({ index: r.index, errors: r.errors })),
      );
    }

    return {
      episodeId: episode.id,
      extractionModel: response.model,
      extractionPromptHash: EXTRACTION_PROMPT_HASH,
      extractionVersion,
      accepted: mapped.accepted,
      rejected: mapped.rejected,
      duplicateCandidates: mapped.duplicateCandidates,
      providerCalls: attempts,
    };
  }
}

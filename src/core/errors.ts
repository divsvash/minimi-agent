export class FencingError extends Error {
  constructor(message = "job fence check failed (generation or lease mismatch)") {
    super(message);
    this.name = "FencingError";
  }
}

export class ClaimConflictError extends Error {
  constructor(message = "job is not currently claimable") {
    super(message);
    this.name = "ClaimConflictError";
  }
}

/**
 * Contract-level error taxonomy (Slice 2). Every failure a caller can meaningfully
 * branch on is one of these; infrastructure oddities should be wrapped into them at
 * the port boundary, never surfaced raw.
 */
export class MinimiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** A referenced entity/statement/observation does not exist. */
export class NotFoundError extends MinimiError {
  constructor(message: string) {
    super("not_found", message);
  }
}

/** Uniqueness or optimistic-concurrency invariant violated. */
export class ConflictError extends MinimiError {
  constructor(message: string) {
    super("conflict", message);
  }
}

/** Input failed contract validation (zod or domain invariants). */
export class ValidationError extends MinimiError {
  constructor(message: string, readonly issues?: unknown) {
    super("validation", message);
  }
}

/** A provider (LLM/embedding/research/fetch) failed. `retryable` drives retry policy at the caller. */
export class ProviderError extends MinimiError {
  constructor(message: string, readonly retryable = false) {
    super("provider_error", message);
  }
}

/** A provider call exceeded its deadline. */
export class ProviderTimeoutError extends ProviderError {
  constructor(message = "provider call timed out") {
    super(message, true);
    this.name = "ProviderTimeoutError";
  }
}

/** A provider could not be reached at all (unavailable, auth, network). */
export class ProviderUnavailableError extends ProviderError {
  constructor(message = "provider unavailable") {
    super(message, true);
    this.name = "ProviderUnavailableError";
  }
}

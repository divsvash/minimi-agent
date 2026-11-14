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

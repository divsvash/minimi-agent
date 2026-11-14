import { createHash, randomUUID } from "node:crypto";

export const ids = {
  uuid(): string {
    return randomUUID();
  },
  /** Deterministic idempotency key for outbox enqueue. */
  jobKey(kind: string, ...parts: string[]): string {
    return `${kind}:${parts.map((p) => p.replace(/\s+/g, " ").trim().toLowerCase()).join(":")}`;
  },
  /** SHA-256 hex of canonical input. */
  sha256(input: string): string {
    return createHash("sha256").update(input, "utf8").digest("hex");
  },
};

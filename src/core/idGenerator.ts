import { ids } from "./ids.js";

/** Source of unique identifiers. Injected everywhere instead of calling randomUUID directly. */
export interface IdGenerator {
  uuid(): string;
}

export const systemIdGenerator: IdGenerator = { uuid: () => ids.uuid() };

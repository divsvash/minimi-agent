import type { EmbeddingProvider } from "../contracts/ports.js";

/**
 * Deterministic, fixture-only embedding provider. Returns the vector supplied
 * for each exact text (empty vector when unspecified). Used by the Slice 4 eval
 * to script a high-cosine similarity without any model or network call.
 */
export class ScriptedEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly calls: string[][] = [];

  constructor(
    private readonly vectors: Record<string, number[]> = {},
    model = "scripted-embed-1",
  ) {
    this.model = model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push([...texts]);
    return texts.map((text) => [...(this.vectors[text] ?? [])]);
  }
}

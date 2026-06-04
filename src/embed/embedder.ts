import { chunkText } from '../pipeline/chunker.js'
import type { EmbedFn } from './ollama-client.js'
import { defaultOllamaEmbed } from './ollama-client.js'
import { meanPool } from './vector.js'

export class Embedder {
  constructor(private readonly embedFn: EmbedFn = defaultOllamaEmbed) {}

  /** Split text, embed parts sequentially (avoids Ollama 503 under burst), mean-pool. Returns the
   *  pooled vector; the caller persists it (no Redis). Empty text → empty vector. */
  async embed(text: string): Promise<number[]> {
    const trimmed = text.trim()
    if (!trimmed) return []

    const toEmbed = chunkText(trimmed)
    if (toEmbed.length === 0) toEmbed.push(trimmed)

    const vectors: number[][] = []
    for (const part of toEmbed) vectors.push(await this.embedFn(part))

    return vectors.length === 1 ? vectors[0]! : meanPool(vectors)
  }
}

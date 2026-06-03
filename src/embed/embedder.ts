import { chunkText } from '../pipeline/chunker.js'
import { getRedis, writeChunkEmbedding } from '../redis.js'
import type { Redis } from 'ioredis'
import type { EmbedFn } from './ollama-client.js'
import { defaultOllamaEmbed } from './ollama-client.js'
import { embeddingToBuffer, meanPool } from './vector.js'

export class Embedder {
  constructor(
    private readonly embedFn: EmbedFn = defaultOllamaEmbed,
    private readonly redis: Redis = getRedis(),
  ) {}

  /** Non-blocking: embed after TURN_END without delaying the hook. */
  scheduleEmbed(sessionId: string, seq: number, text: string): void {
    void this.embedChunk(sessionId, seq, text).catch(err => {
      console.error(`[memwise] embed failed ${sessionId}:${seq}`, err)
    })
  }

  /** Split text, embed parts concurrently, mean-pool, write vector in place on the Redis hash. */
  async embedChunk(sessionId: string, seq: number, text: string): Promise<number[]> {
    const trimmed = text.trim()
    if (!trimmed) return []

    const parts = chunkText(trimmed)
    const vectors =
      parts.length > 0
        ? await Promise.all(parts.map(p => this.embedFn(p)))
        : [await this.embedFn(trimmed)]

    const pooled = vectors.length === 1 ? vectors[0]! : meanPool(vectors)
    await writeChunkEmbedding(sessionId, seq, embeddingToBuffer(pooled), this.redis)
    return pooled
  }
}

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

  /** Split text, embed parts sequentially (avoids Ollama 503 under burst), mean-pool, write. */
  async embedChunk(sessionId: string, seq: number, text: string): Promise<number[]> {
    const trimmed = text.trim()
    if (!trimmed) return []

    const toEmbed = chunkText(trimmed)
    if (toEmbed.length === 0) toEmbed.push(trimmed)

    const vectors: number[][] = []
    for (const part of toEmbed) vectors.push(await this.embedFn(part))

    const pooled = vectors.length === 1 ? vectors[0]! : meanPool(vectors)
    await writeChunkEmbedding(sessionId, seq, embeddingToBuffer(pooled), this.redis)
    return pooled
  }
}

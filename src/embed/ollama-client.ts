import { EMBED_DIM, EMBED_MODEL, OLLAMA_URL } from '../core/config.js'

export type EmbedFn = (text: string) => Promise<number[]>

export class OllamaClient {
  constructor(
    private readonly baseUrl: string = OLLAMA_URL,
    private readonly model: string = EMBED_MODEL,
    private readonly dim: number = EMBED_DIM,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async embedText(text: string): Promise<number[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt: text }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) {
      throw new Error(`Ollama embed HTTP ${res.status}: ${await res.text()}`)
    }
    const body = (await res.json()) as { embedding?: number[] }
    if (!Array.isArray(body.embedding)) {
      throw new Error('Ollama response missing embedding array')
    }
    if (body.embedding.length !== this.dim) {
      throw new Error(
        `Ollama returned ${body.embedding.length} dims, expected ${this.dim}`,
      )
    }
    if (!body.embedding.every(v => typeof v === 'number' && isFinite(v))) {
      throw new Error('Ollama embedding contains non-finite values')
    }
    return body.embedding
  }

  async ping(): Promise<void> {
    await this.embedText('ping')
  }
}

export const defaultOllamaEmbed: EmbedFn = (text) => new OllamaClient().embedText(text)

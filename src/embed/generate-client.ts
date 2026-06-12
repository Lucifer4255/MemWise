import { ENRICH_MODEL, ENRICH_SEED, OLLAMA_URL } from '../core/config.js'

/**
 * Chat/generation client for the local enrichment model (Ollama `/api/generate`). Separate from
 * the embedding client (`ollama-client.ts`) — different endpoint, different model. Used by the
 * Layer 8 enricher to rewrite a turn's context before it is embedded.
 */
export class GenerateClient {
  constructor(
    private readonly baseUrl: string = OLLAMA_URL,
    private readonly model: string = ENRICH_MODEL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get modelName(): string {
    return this.model
  }

  /**
   * One-shot completion. `timeoutMs` aborts a slow model so capture never hangs.
   * The sampling seed is pinned (ENRICH_SEED) so identical input yields identical output —
   * the consolidation jobs depend on this. `opts.json` constrains output to valid JSON
   * (Ollama `format:"json"`); use it for the structured jobs, NOT the prose enricher.
   */
  async generate(
    prompt: string,
    system: string | undefined,
    timeoutMs: number,
    opts: { json?: boolean } = {},
  ): Promise<string> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt,
        ...(system ? { system } : {}),
        stream: false,
        ...(opts.json ? { format: 'json' } : {}),
        options: { temperature: 0.2, seed: ENRICH_SEED },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      throw new Error(`Ollama generate HTTP ${res.status}: ${await res.text()}`)
    }
    const body = (await res.json()) as { response?: string }
    return typeof body.response === 'string' ? body.response : ''
  }

  /** True if `model` is pulled locally (probe `/api/tags`). Used to gate enrichment. */
  async isAvailable(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3_000),
      })
      if (!res.ok) return false
      const body = (await res.json()) as { models?: { name?: string }[] }
      const names = (body.models ?? []).map(m => m.name ?? '')
      // Match exact, or ignoring a `:latest`/tag mismatch on the bare model name.
      const bare = this.model.split(':')[0]
      return names.some(n => n === this.model || n.split(':')[0] === bare)
    } catch {
      return false
    }
  }
}

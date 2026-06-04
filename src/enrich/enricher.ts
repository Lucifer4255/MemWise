import { ENRICH_ENABLED, ENRICH_TIMEOUT_MS } from '../config.js'
import { GenerateClient } from '../embed/generate-client.js'
import type { FinalizedMessage } from '../types.js'

const SYSTEM = [
  'You rewrite a coding-session memory note so a future AI agent can recall what happened and WHY.',
  'Rules:',
  '- Keep it factual and specific. Do NOT invent details not present in the input.',
  '- Turn vague narration ("updated the code") into concrete prose naming files, symbols, and the reason.',
  '- For each code change, state briefly why it was made if the input implies it.',
  '- Output ONLY the rewritten note as plain prose. No preamble, no markdown headers, no bullet symbols required.',
  '- Be concise: a few sentences, not an essay.',
].join('\n')

export interface EnrichResult {
  text: string
  enriched: boolean
  ms: number
  model: string | null
}

function buildPrompt(msg: FinalizedMessage): string {
  const changes = msg.codeChanges
    .map(c => `- ${c.changeType} ${c.symbol || '(file)'} in ${c.file}`)
    .join('\n')
  return [
    `User prompt:\n${msg.promptText}`,
    '',
    `Captured notes:\n${msg.contextText}`,
    '',
    changes ? `Code changes:\n${changes}` : 'Code changes: none',
    '',
    'Rewrite the captured notes into a single concise memory note:',
  ].join('\n')
}

/**
 * Rewrite a message's contextText with the local chat model BEFORE embedding. Graceful by design:
 * a missing model, a timeout, or any error returns the raw contextText unchanged so capture never
 * fails. The caller embeds whatever text comes back and is written once.
 */
export class Enricher {
  constructor(
    private readonly client: GenerateClient = new GenerateClient(),
    private readonly timeoutMs: number = ENRICH_TIMEOUT_MS,
  ) {}

  async enrich(msg: FinalizedMessage): Promise<EnrichResult> {
    const t0 = performance.now()
    const raw = msg.contextText
    if (ENRICH_ENABLED === 'off' || !raw.trim()) {
      return { text: raw, enriched: false, ms: 0, model: null }
    }
    if (ENRICH_ENABLED === 'auto' && !(await this.client.isAvailable())) {
      return { text: raw, enriched: false, ms: performance.now() - t0, model: null }
    }
    try {
      const out = await this.client.generate(buildPrompt(msg), SYSTEM, this.timeoutMs)
      const cleaned = out.trim()
      if (!cleaned) return { text: raw, enriched: false, ms: performance.now() - t0, model: null }
      return { text: cleaned, enriched: true, ms: performance.now() - t0, model: this.client.modelName }
    } catch {
      // timeout / model down / bad response → fall back to raw, still written once.
      return { text: raw, enriched: false, ms: performance.now() - t0, model: null }
    }
  }
}

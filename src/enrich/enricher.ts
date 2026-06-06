import { ENRICH_ENABLED, ENRICH_TIMEOUT_MS } from '../core/config.js'
import { GenerateClient } from '../embed/generate-client.js'
import type { FinalizedMessage } from '../core/types.js'

const SYSTEM = [
  'You write a one-line TL;DR for a coding-session memory note, so a future AI agent can grasp the gist at a glance.',
  'Rules:',
  '- Keep it factual and specific. Do NOT invent details not present in the input.',
  '- Name the key file(s)/symbol(s) touched and the reason for the change if the input implies it.',
  '- ONE or at most TWO sentences. No preamble, no markdown headers, no bullet symbols, no "TL;DR:" prefix.',
  '- This is a summary that sits ABOVE the raw notes — do not restate everything, just the gist.',
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
    'Write the one-line TL;DR:',
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
    // Enrichment rewrites code-edit narration into a concise why-note — its whole system prompt is
    // built around naming files/symbols/reasons. On a pure discussion/Q&A turn (no code changes) it
    // has nothing to ground on and emits vague filler ("No code changes were made. The discussion
    // was about…"), which is worse than the raw context. Skip it and keep the faithful raw text.
    if (msg.codeChanges.length === 0) {
      return { text: raw, enriched: false, ms: 0, model: null }
    }
    if (ENRICH_ENABLED === 'auto' && !(await this.client.isAvailable())) {
      return { text: raw, enriched: false, ms: performance.now() - t0, model: null }
    }
    try {
      const out = await this.client.generate(buildPrompt(msg), SYSTEM, this.timeoutMs)
      const tldr = out.trim().replace(/^TL;?DR:?\s*/i, '') // strip a stray prefix if the model adds one
      if (!tldr) return { text: raw, enriched: false, ms: performance.now() - t0, model: null }
      // Prepend the TL;DR, KEEP the raw notes verbatim below it. This preserves keyword/FTS recall
      // (the raw text survives) while adding a distilled semantic summary on top — best of both,
      // and the embedding (computed over the combined text) gets both signals.
      const text = `TL;DR: ${tldr}\n\n${raw}`
      return { text, enriched: true, ms: performance.now() - t0, model: this.client.modelName }
    } catch {
      // timeout / model down / bad response → fall back to raw, still written once.
      return { text: raw, enriched: false, ms: performance.now() - t0, model: null }
    }
  }
}

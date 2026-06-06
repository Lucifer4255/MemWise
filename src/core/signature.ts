import { createHash } from 'node:crypto'
import type { CodeChange } from './types.js'

export function serializeEdits(changes: CodeChange[]): string {
  const sorted = [...changes].sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file)
    if (a.symbol !== b.symbol) return a.symbol.localeCompare(b.symbol)
    return a.changeType.localeCompare(b.changeType)
  })
  return JSON.stringify(sorted)
}

/**
 * Message-level signature — one sig per user prompt (the spine).
 * INVARIANT: inputs must be raw deterministic values. NEVER pass LLM output here —
 * the sig is identity; LLM enrichment is a separate, non-hashed content attribute.
 * sha256(promptText + NUL + serialize(all_edits_in_message))
 */
export function computeMessageSig(promptText: string, codeChanges: CodeChange[]): string {
  const payload = `${promptText}\x00${serializeEdits(codeChanges)}`
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

export function worthStoringMessage(codeChanges: CodeChange[], contextText: string): boolean {
  if (codeChanges.length > 0) return true
  return contextText.trim().length >= 40
}

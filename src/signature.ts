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

/** Focused intent for hashing + embedding; empty narration falls back to promptText. */
export function resolveIntentText(intentText: string | null | undefined, promptText: string): string {
  const trimmed = intentText?.trim()
  if (trimmed) return trimmed
  return promptText.trim()
}

/**
 * spec §6.2:
 * sha256(promptText + NUL + segmentIdx + NUL + intentText + NUL + serialize(edits))
 */
export function computeSignature(
  promptText: string,
  segmentIdx: number,
  intentText: string | null | undefined,
  edits: CodeChange[],
): string {
  const intent = resolveIntentText(intentText, promptText)
  const payload = `${promptText}\x00${segmentIdx}\x00${intent}\x00${serializeEdits(edits)}`
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

export function worthStoringSegment(
  segment: { codeChanges: CodeChange[]; messageChunks: string[]; intentText?: string | null },
): boolean {
  if (segment.codeChanges.length > 0) return true
  const text = (segment.messageChunks.join(' ') || segment.intentText || '').trim()
  return text.length >= 40
}

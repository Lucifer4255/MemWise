/** Shared helpers for the LLM consolidation jobs (semantic Job 3, procedural Job 4). */

/**
 * Tolerant JSON parse for local-model output. Small chat models often wrap JSON in ```fences```,
 * add a prose preamble, or trail commentary. Strip fences, slice to the outermost {...}, parse.
 * Returns null on any failure so the caller degrades to a no-op (never throws on bad output).
 */
export function parseJsonLoose<T = unknown>(raw: string): T | null {
  if (!raw) return null
  let s = raw.trim()
  // Strip ```json … ``` or ``` … ``` fences.
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  // Slice to the outermost object braces if there's surrounding prose.
  const first = s.indexOf('{')
  const last = s.lastIndexOf('}')
  if (first === -1 || last === -1 || last < first) return null
  s = s.slice(first, last + 1)
  try {
    return JSON.parse(s) as T
  } catch {
    return null
  }
}

/**
 * Guard against junk the local model sometimes emits in place of a real fact/pattern: empty strings,
 * lone ellipses or punctuation ("...", "-"), or fragments too short to be a durable statement. These
 * leak into storage as garbage rows otherwise. Returns true when `text` is NOT worth keeping.
 */
/** Per-item length caps (chars) for consolidation material. Session summaries run to several KB each;
 *  fed whole, a handful blows past a small local model's context window and it extracts NOTHING. Cap
 *  each item so the full prompt stays within ~a few thousand tokens. */
const SUMMARY_CAP = 700
const NOTE_CAP = 400

function clip(s: string, cap: number): string {
  const t = s.trim()
  return t.length <= cap ? t : t.slice(0, cap) + '…'
}

/**
 * Build the "Recent notes" block for a consolidation prompt from summaries + chunk texts. Clips each
 * item to a length cap (so large summaries don't overflow the model's context — the #1 cause of empty
 * extractions) and drops exact-duplicate lines (order-preserving), since repeated chunks make small
 * models abstain.
 */
export function buildMaterial(summaries: string[], notes: string[]): string {
  const lines = [
    ...summaries.map(s => `[summary] ${clip(s, SUMMARY_CAP)}`),
    ...notes.map(n => `[note] ${clip(n, NOTE_CAP)}`),
  ]
  const seen = new Set<string>()
  const deduped: string[] = []
  for (const line of lines) {
    const key = line.trim().toLowerCase()
    if (!key || seen.has(key)) continue
    seen.add(key)
    deduped.push(line)
  }
  return deduped.join('\n\n')
}

export function isJunkText(text: string): boolean {
  const t = (text ?? '').trim()
  if (t.length < 8) return true
  // Must contain at least a couple of word characters — rejects "...", "-- --", etc.
  const words = t.match(/[A-Za-z0-9]{2,}/g)
  return !words || words.length < 2
}

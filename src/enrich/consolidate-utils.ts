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

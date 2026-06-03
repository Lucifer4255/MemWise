import type { MemoryStore } from '../store/memory-store.js'
import type { RouteResult } from './types.js'

// "Catch me up" / cross-agent handoff: a project-wide recap of current work, distinct from
// recency (resume MY last turn). Checked first — these phrases also contain recency-ish words.
const SESSION_RE =
  /what (?:are|were|am|was) (?:we|i) (?:working|doing)|what we(?:'re| are) (?:working|doing)|catch me up|current context|context of what|get the context|where are we|what's going on|whats going on|\brecap\b/i

const RECENCY_RE = /continue|where was i|pick up|left off/i

const SYMBOL_RE =
  /\b([a-z][a-zA-Z0-9]*|[A-Z][a-zA-Z0-9]*(?:[A-Z][a-z0-9]*)+)\b|([a-z][a-z0-9]*(?:_[a-z0-9]+)+)/g

const STOPWORDS = new Set([
  'why',
  'how',
  'what',
  'when',
  'where',
  'does',
  'the',
  'and',
  'for',
  'with',
  'from',
  'this',
  'that',
  'retry',
  'retries',
])

export function extractSymbols(query: string): string[] {
  const found = new Set<string>()
  for (const match of query.matchAll(SYMBOL_RE)) {
    const sym = (match[1] ?? match[2] ?? '').trim()
    if (sym.length < 3) continue
    if (STOPWORDS.has(sym.toLowerCase())) continue
    found.add(sym)
  }
  return [...found]
}

export function route(query: string, store?: MemoryStore): RouteResult {
  const trimmed = query.trim()
  if (!trimmed) return { mode: 'semantic' }

  if (SESSION_RE.test(trimmed)) {
    return { mode: 'session' }
  }

  if (RECENCY_RE.test(trimmed)) {
    return { mode: 'recency' }
  }

  const symbols = extractSymbols(trimmed)
  if (symbols.length > 0 && store) {
    for (const sym of symbols) {
      if (store.queryChangesForSymbol(sym).length > 0) {
        return { mode: 'symbol', symbols }
      }
    }
  }

  return { mode: 'semantic', symbols: symbols.length > 0 ? symbols : undefined }
}

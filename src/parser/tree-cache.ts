import type Parser from 'tree-sitter'
import type { SupportedLanguage } from './types.js'

interface CacheEntry {
  content: string
  tree: Parser.Tree
}

/**
 * Per-session file tree cache. Tracks full vs incremental parse paths for tests.
 * Compare trees for getChangedRanges are parsed fresh and do NOT increment counters.
 */
export class TreeCache {
  fullParseCount = 0
  incrementalParseCount = 0

  private readonly entries = new Map<string, CacheEntry>()

  private key(sessionId: string, file: string): string {
    return `${sessionId}\0${file}`
  }

  getEntry(sessionId: string, file: string, content: string): CacheEntry | undefined {
    const entry = this.entries.get(this.key(sessionId, file))
    if (!entry || entry.content !== content) return undefined
    return entry
  }

  noteFullParse(): void {
    this.fullParseCount++
  }

  noteIncrementalParse(): void {
    this.incrementalParseCount++
  }

  setEntry(sessionId: string, file: string, content: string, tree: Parser.Tree): void {
    this.entries.set(this.key(sessionId, file), { content, tree })
  }

  reset(): void {
    this.entries.clear()
    this.fullParseCount = 0
    this.incrementalParseCount = 0
  }

  stats(): { fullParseCount: number; incrementalParseCount: number } {
    return {
      fullParseCount: this.fullParseCount,
      incrementalParseCount: this.incrementalParseCount,
    }
  }
}

export type { SupportedLanguage }

import type { Range as TsRange } from 'tree-sitter'
import type { SymbolDep } from '../types.js'

export type SupportedLanguage =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'python'
  | 'go'
  | 'java'
  | 'cpp'
  | 'c'
  | 'rust'

/** Byte/row edit applied between old and new file content. */
export interface EditRange {
  startIndex: number
  oldEndIndex: number
  newEndIndex: number
}

export interface ParseJob {
  sessionId: string
  file: string
  oldContent: string
  newContent: string
  /** When omitted, a single contiguous diff is inferred from old/new text. */
  edits?: EditRange[]
}

export interface ChangedSymbol {
  file: string
  symbol: string
  symbolType: string
}

export interface ParseResult {
  symbols: ChangedSymbol[]
  /** Dependency edges (call + import) for the changed declarations → symbol_dep rows. */
  deps: SymbolDep[]
  changedRanges: TsRange[]
  /** True when no AST symbols were found — caller used file-level fallback. */
  fileLevelFallback: boolean
}

export type WorkerRequest =
  | { id: number; type: 'parse'; job: ParseJob }
  | { id: number; type: 'stats' }
  | { id: number; type: 'shutdown' }

export type WorkerResponse =
  | { id: number; ok: true; result: ParseResult; stats: CacheStats }
  | { id: number; ok: false; error: string }
  | { id: number; ok: true; stats: CacheStats }

export interface CacheStats {
  fullParseCount: number
  incrementalParseCount: number
}

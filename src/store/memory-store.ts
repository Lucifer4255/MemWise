export type Source = 'claude-code' | 'codex' | 'cursor'

// The "spine" — one row per user message. Identity only; the embeddable pooled
// context lives on context_chunk, the code edits on `change`. All joined by `sig`.
export interface PromptSig {
  sig: string
  parentSig: string | null
  promptText: string
  sessionId: string
  source: Source
  projectId: string
  ts: number
}

export interface Change {
  sig: string
  file: string
  symbol: string
  changeType: 'added' | 'modified' | 'deleted'
}

export interface ContextChunk {
  id: string
  sig: string
  text: string
  projectId: string
  ts: number
}

export interface SymbolDep {
  fromSymbol: string
  fromFile: string
  toSymbol: string
  toFile: string
}

export interface SessionSummary {
  id: number
  projectId: string
  source: 'postcompact' | 'nightshift'
  sigRange: string
  summary: string
  ts: number
}

export interface MemoryStore {
  runTransaction(fn: () => void): void
  queryLatestSessionSummary(projectId: string): SessionSummary | undefined
  insertPromptSig(sig: PromptSig): void
  insertPromptSigOrIgnore(sig: PromptSig): void
  getPromptSig(sig: string): PromptSig | undefined
  insertChange(change: Change): void
  insertSymbolDep(dep: SymbolDep): void
  insertContextChunk(chunk: ContextChunk, embedding: number[]): void
  queryHybrid(embedding: number[], keywords: string, limit: number): ContextChunk[]
  queryHybridScoped(
    projectId: string,
    embedding: number[],
    keywords: string,
    limit: number,
  ): ContextChunk[]
  queryRecentChunks(projectId: string, limit: number): ContextChunk[]
  queryRecentPromptSigs(projectId: string, limit: number): PromptSig[]
  getChangesForSig(sig: string): Change[]
  getContextChunkBySig(sig: string): ContextChunk | undefined
  getParentChain(sig: string, maxDepth: number): PromptSig[]
  queryChangesForSymbol(symbol: string): Change[]
  queryBlastRadius(symbol: string, file: string, depth?: number): SymbolDep[]
}

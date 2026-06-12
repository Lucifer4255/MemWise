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
  /** v5: true when the chat model rewrote this text before embedding (Layer 8). */
  enriched?: boolean
}

export interface SymbolDep {
  fromSymbol: string
  fromFile: string
  toSymbol: string
  toFile: string
}

/** A directed edge in the turn graph (v6).
 *  'file'/'symbol' edges: from=newer turn, to=most-recent prior turn touching the same file/symbol.
 *  'forward' edge: from=parent turn, to=child turn (spine direction, enables forward traversal). */
export interface TurnEdge {
  fromSig: string
  toSig: string
  edgeType: 'file' | 'symbol' | 'forward'
  label: string
  ts: number
}

export interface SessionSummary {
  id: number
  projectId: string
  source: 'postcompact' | 'nightshift'
  sigRange: string
  summary: string
  ts: number
}

/** Per-session transcript read position (Layer 8 transcript capture). */
export interface CaptureCursor {
  sessionId: string
  lastUuid: string
  ts: number
}

export type TelemetryKind = 'message' | 'enrich' | 'embed' | 'job2' | 'job3' | 'job4'

export interface TelemetryEvent {
  id: number
  ts: number
  kind: TelemetryKind
  /** JSON-decoded event fields (shape depends on kind). */
  payload: Record<string, unknown>
}

/** A captured message joined with its context text — what the dashboard lists. */
export interface RecentMessage {
  sig: string
  projectId: string
  promptText: string
  text: string
  enriched: boolean
  ts: number
}

/** One row in the projects list — aggregate counts per project_id. */
export interface ProjectSummary {
  projectId: string
  messages: number
  summaries: number
  facts: number
  patterns: number
  lastTs: number
}

/** Semantic tier (M2): a durable extracted fact about the project. `support` counts how many times
 *  it was re-observed (reinforcement); `lastSeen` drives time-decay. */
export interface SemanticFact {
  id: string
  projectId: string
  fact: string
  confidence: number
  support: number
  createdTs: number
  lastSeen: number
}

/** Procedural tier (M2): a recurring workflow/decision pattern. `sequence` is JSON-encoded steps;
 *  `freq` counts reinforcement; `lastSeen` drives time-decay. */
export interface ProceduralPattern {
  id: string
  projectId: string
  pattern: string
  sequence: string
  freq: number
  createdTs: number
  lastSeen: number
}

export interface MemoryStore {
  runTransaction(fn: () => void): void
  insertSessionSummary(row: Omit<SessionSummary, 'id'>): void
  queryLatestSessionSummary(projectId: string): SessionSummary | undefined
  /** Recent summaries for a project (any source), newest first — Job 2 reads postcompact rows. */
  queryRecentSessionSummaries(projectId: string, limit: number): SessionSummary[]
  getCaptureCursor(sessionId: string): CaptureCursor | undefined
  setCaptureCursor(cursor: CaptureCursor): void
  insertTelemetry(kind: TelemetryKind, payload: Record<string, unknown>): void
  queryRecentTelemetry(afterId: number, limit: number): TelemetryEvent[]
  queryRecentMessages(limit: number): RecentMessage[]
  queryRecentMessagesScoped(projectId: string, limit: number): RecentMessage[]
  queryProjects(): ProjectSummary[]
  // ── semantic tier (M2) ────────────────────────────────────────────────────────────────────
  upsertSemanticFact(fact: Omit<SemanticFact, 'support' | 'createdTs'>): void
  reinforceSemanticFact(id: string, confidence: number, now: number): void
  querySemanticFacts(projectId: string, limit: number): SemanticFact[]
  deleteSemanticFact(id: string): void
  // ── procedural tier (M2) ──────────────────────────────────────────────────────────────────
  upsertProcedural(p: Omit<ProceduralPattern, 'freq' | 'createdTs'>): void
  reinforceProcedural(id: string, now: number): void
  queryProcedural(projectId: string, limit: number): ProceduralPattern[]
  deleteProcedural(id: string): void
  /** Count chunks for a project newer than `sinceTs` — Job 2's "enough new work?" gate. */
  countChunksSince(projectId: string, sinceTs: number): number
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
  queryRecentChangeLinkedChunks(projectId: string, limit: number): ContextChunk[]
  queryRecentPromptSigs(projectId: string, limit: number): PromptSig[]
  getChangesForSig(sig: string): Change[]
  getContextChunkBySig(sig: string): ContextChunk | undefined
  getParentChain(sig: string, maxDepth: number): PromptSig[]
  queryChangesForSymbol(symbol: string): Change[]
  queryBlastRadius(symbol: string, file: string, depth?: number): SymbolDep[]
  // ── turn graph (v6) ──────────────────────────────────────────────────────────────────────
  insertTurnEdgeOrIgnore(edge: TurnEdge): void
  /** Most recent sig (in this project, excluding `excludeSig`) that touched `file`. */
  getPriorTurnForFile(file: string, projectId: string, excludeSig: string): string | undefined
  /** Most recent sig (in this project, excluding `excludeSig`) that touched `symbol`. */
  getPriorTurnForSymbol(symbol: string, projectId: string, excludeSig: string): string | undefined
  /** All edges where `sig` is either endpoint — both directions in one call. */
  getEdgeNeighbors(sig: string, limit: number): TurnEdge[]
}

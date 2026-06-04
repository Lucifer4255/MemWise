import type { EmbedFn } from '../embed/ollama-client.js'
import type { Change, ContextChunk, MemoryStore, PromptSig, SessionSummary, SymbolDep } from '../store/memory-store.js'

export type RouteMode = 'recency' | 'symbol' | 'semantic' | 'session'

export interface RouteResult {
  mode: RouteMode
  symbols?: string[]
}

export interface AnchorHit {
  sig: string
  text: string
  ts: number
  sources: string[]
}

export interface ContextBundle {
  anchors: AnchorHit[]
  changes: Change[]
  chunks: ContextChunk[]
  parentChains: PromptSig[][]
  symbolChanges: Change[]
  watchEdges: SymbolDep[]
  mode: RouteMode
  /** Session-recap mode only: recent project prompts (newest first) → "Working on" section. */
  recentPrompts?: PromptSig[]
  /** Session-recap mode only: latest daemon-written summary for the project (Layer 8). */
  latestSummary?: SessionSummary
}

export interface RetrieveOptions {
  projectId?: string
  sessionId?: string
  store?: MemoryStore
  embedFn?: EmbedFn
  maxTokens?: number
  hybridLimit?: number
  /** Force a route mode, bypassing the NL router (e.g. the memwise_session tool forces 'session'). */
  mode?: RouteMode
}

export interface RetrieveResult {
  block: string
  tokenCount: number
  anchors: AnchorHit[]
  timingMs: number
}

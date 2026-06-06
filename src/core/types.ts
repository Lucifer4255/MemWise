export type { Change, ContextChunk, PromptSig, Source, SymbolDep } from './store/memory-store.js'
import type { SymbolDep } from './store/memory-store.js'

export type HookKind =
  | 'PROMPT'
  | 'TOOL'
  | 'TOOL_FAILED'
  | 'TOOL_BATCH'
  | 'NARRATION'
  | 'TURN_END'
  | 'PRE_COMPACT'
  | 'POST_COMPACT'
  | 'SESSION_START'

export interface CodeChange {
  file: string
  symbol: string
  changeType: 'added' | 'modified' | 'deleted'
}

export interface CaptureEvent {
  source: 'claude-code' | 'codex' | 'cursor'
  hook: HookKind
  sessionId: string
  turnId?: string
  seq: number
  projectPath: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolResponse?: unknown
  message?: string
  isFailure?: boolean
  // True for a turn-final assistant message (Cursor afterAgentResponse). Closing summaries
  // attach to the last segment instead of opening a new one.
  isClosing?: boolean
  transcriptPath?: string | null
  ts: number
}

/** Internal turn accumulator. Segments are pooled into ONE FinalizedMessage at close —
 *  the narration/edit split is bookkeeping during the turn, NOT a persisted unit. */
export interface Segment {
  intentText: string | null
  codeChanges: CodeChange[]
  messageChunks: string[]
}

export interface Bracket {
  promptText: string
  segments: Segment[]
  sessionId: string
  turnId: string | null
  projectId: string
  source: 'claude-code' | 'codex' | 'cursor'
  tsOpen: number
  // File paths touched by Read/Grep/LS/Glob during this turn — NOT code changes, but used
  // for parent_sig resolution so execution→plan lineage wires up even when file sets differ.
  touchedFiles: string[]
  // Dependency edges (call + import) accumulated from tree-sitter across the turn's edits.
  symbolDeps: SymbolDep[]
  // Turn-final summary stashed from a closing narration (Cursor afterAgentResponse), applied
  // at close when the TURN_END event itself carries no message (Cursor's stop has none).
  closingMessage?: string
}

/** The single persisted unit per user message — one sig, one context vector, N code-change children. */
export interface FinalizedMessage {
  sig: string
  parentSig: string | null
  promptText: string
  contextText: string        // pooled narration + closing summary → ONE embedded string
  codeChanges: CodeChange[]  // ALL changes across all internal segments → graph children
  symbolDeps: SymbolDep[]    // call/import edges → symbol_dep rows (persisted at Layer 5 flush)
  projectId: string
  sessionId: string
  source: 'claude-code' | 'codex' | 'cursor'
  tsOpen: number
  ts: number
}

export function createEmptySegment(): Segment {
  return {
    intentText: null,
    codeChanges: [],
    messageChunks: [],
  }
}

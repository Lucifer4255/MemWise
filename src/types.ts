export type { Change, ContextChunk, PromptSig, Source, SymbolDep } from './store/memory-store.js'

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

export interface Segment {
  signature: string | null
  parentSig: string | null
  segmentIdx: number
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
  // Turn-final summary stashed from a closing narration (Cursor afterAgentResponse), applied
  // at close when the TURN_END event itself carries no message (Cursor's stop has none).
  closingMessage?: string
}

export interface FinalizedSegment {
  bracket: Bracket
  segment: Segment
  worthStore: boolean
}

export function createEmptySegment(segmentIdx: number): Segment {
  return {
    signature: null,
    parentSig: null,
    segmentIdx,
    intentText: null,
    codeChanges: [],
    messageChunks: [],
  }
}

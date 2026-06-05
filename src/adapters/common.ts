import type { CaptureEvent, HookKind } from '../types.js'

export interface AdapterContext {
  seq: number
}

export type RawHookPayload = Record<string, unknown>

/** The coding agents MemWise adapts to. */
export type AgentSource = CaptureEvent['source']

/** One replayed hook payload from a transcript, with its timestamp. */
export interface ReplayEvent {
  payload: RawHookPayload
  ts: number
}

/** Result of reading an on-disk transcript: replayable payloads + resolved scope. */
export interface TranscriptRead {
  events: ReplayEvent[]
  sessionId: string
  projectPath: string
}

/** Scope carried from the live hook payload into a transcript read. Some agents' transcript
 *  entries don't repeat session/project identity (Cursor), so the hook supplies the defaults. */
export interface TranscriptHint {
  sessionId?: string
  projectPath?: string
}

/**
 * Strategy — one per coding agent. Encapsulates the two agent-specific operations so the
 * capture pipeline (turn-capture.ts) can stay agent-agnostic:
 *   1. parseHook      — normalize ONE live (or replayed) hook payload → CaptureEvent
 *   2. readTranscript — turn that agent's on-disk transcript into replayable hook payloads
 *
 * The two compose: readTranscript emits payloads that this same adapter's parseHook consumes,
 * so replay drives the exact path real hooks will. Concrete strategies live in
 * claude-code.ts / codex.ts / cursor.ts; the registry that selects one is in index.ts.
 */
export interface AgentAdapter {
  readonly source: AgentSource
  parseHook(raw: RawHookPayload, ctx: AdapterContext): CaptureEvent | null
  readTranscript(path: string, hint?: TranscriptHint): TranscriptRead
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function baseCaptureFields(
  raw: RawHookPayload,
  source: CaptureEvent['source'],
  hook: HookKind,
  ctx: AdapterContext,
): Omit<CaptureEvent, 'message' | 'toolName' | 'toolInput' | 'toolResponse' | 'isFailure'> {
  const sessionId =
    asString(raw.session_id) ??
    asString(raw.conversation_id) ??
    'unknown-session'

  const projectPath =
    asString(raw.cwd) ??
    (Array.isArray(raw.workspace_roots) ? asString(raw.workspace_roots[0]) : undefined) ??
    ''

  return {
    source,
    hook,
    sessionId,
    turnId: asString(raw.turn_id) ?? asString(raw.generation_id),
    seq: ctx.seq,
    projectPath,
    transcriptPath: asString(raw.transcript_path) ?? null,
    ts: Date.now(),
  }
}

export function toolInputFromRaw(raw: RawHookPayload): Record<string, unknown> | undefined {
  const input = raw.tool_input
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>
  }
  return undefined
}

export function isCodexToolFailure(raw: RawHookPayload): boolean {
  // PostToolUse carries tool_response (Claude-Code-compatible schema)
  const response = raw.tool_response
  if (typeof response === 'object' && response !== null) {
    const exitCode = (response as Record<string, unknown>).exit_code
    if (typeof exitCode === 'number' && exitCode !== 0) return true
  }
  if (typeof response === 'string' && /exit code [1-9]/i.test(response)) return true
  return false
}

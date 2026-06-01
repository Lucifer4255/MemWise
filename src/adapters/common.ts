import type { CaptureEvent, HookKind } from '../types.js'

export interface AdapterContext {
  seq: number
}

export type RawHookPayload = Record<string, unknown>

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

import type { CaptureEvent, HookKind } from '../types.js'
import {
  asString,
  baseCaptureFields,
  toolInputFromRaw,
  type AdapterContext,
  type RawHookPayload,
} from './common.js'

const CLAUDE_HOOK_MAP: Record<string, HookKind> = {
  UserPromptSubmit: 'PROMPT',
  PostToolUse: 'TOOL',
  PostToolUseFailure: 'TOOL_FAILED',
  PostToolBatch: 'TOOL_BATCH',
  MessageDisplay: 'NARRATION',
  Stop: 'TURN_END',
  PreCompact: 'PRE_COMPACT',
  PostCompact: 'POST_COMPACT',
  SessionStart: 'SESSION_START',
}

// MessageDisplay streams in chunks: same message_id, incrementing index, final=true on last.
// Buffer deltas until final=true, then emit one NARRATION with the assembled text.
const deltaBuffers = new Map<string, { chunks: Map<number, string>; highestIndex: number }>()

function accumulateDelta(raw: RawHookPayload): string | null {
  const messageId = asString(raw.message_id)
  const delta = asString(raw.delta) ?? ''
  const index = typeof raw.index === 'number' ? raw.index : 0
  const isFinal = raw.final === true

  if (!messageId) return delta || null

  if (!deltaBuffers.has(messageId)) {
    deltaBuffers.set(messageId, { chunks: new Map(), highestIndex: -1 })
  }
  const buf = deltaBuffers.get(messageId)!
  if (delta) buf.chunks.set(index, delta)
  buf.highestIndex = Math.max(buf.highestIndex, index)

  if (!isFinal) return null

  // Final chunk arrived — assemble in index order and clean up
  const assembled = [...buf.chunks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, text]) => text)
    .join('')
  deltaBuffers.delete(messageId)
  return assembled || null
}

export function parseClaudeCodeHook(raw: RawHookPayload, ctx: AdapterContext): CaptureEvent | null {
  const eventName = asString(raw.hook_event_name) ?? ''
  const hook = CLAUDE_HOOK_MAP[eventName]
  if (!hook) return null // unknown/future hook — ignore gracefully (27+ events, we handle ~9)

  const base = baseCaptureFields(raw, 'claude-code', hook, ctx)

  if (hook === 'PROMPT') {
    return { ...base, message: asString(raw.prompt) }
  }

  if (hook === 'NARRATION') {
    // MessageDisplay: text is in `delta`, streaming until `final: true`.
    // Returns null for non-final chunks (caller should discard); assembled text on final.
    const text = accumulateDelta(raw)
    if (text === null) return null
    return { ...base, message: text }
  }

  if (hook === 'TURN_END') {
    // Stop carries last_assistant_message — the final "why" without parsing the transcript.
    return { ...base, message: asString(raw.last_assistant_message) }
  }

  if (hook === 'TOOL') {
    // PostToolUse: result is in `tool_response` (docs §PostToolUse input).
    return {
      ...base,
      toolName: asString(raw.tool_name),
      toolInput: toolInputFromRaw(raw),
      toolResponse: raw.tool_response,
      isFailure: false,
    }
  }

  if (hook === 'TOOL_FAILED') {
    // PostToolUseFailure: error is a top-level `error` string (no tool_response).
    return {
      ...base,
      toolName: asString(raw.tool_name),
      toolInput: toolInputFromRaw(raw),
      toolResponse: asString(raw.error),
      isFailure: true,
    }
  }

  return base
}

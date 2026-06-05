import { readCursorTranscript } from '../replay/cursor-transcript.js'
import type { CaptureEvent, HookKind } from '../types.js'
import {
  asString,
  baseCaptureFields,
  toolInputFromRaw,
  type AdapterContext,
  type AgentAdapter,
  type RawHookPayload,
} from './common.js'

const CURSOR_HOOK_MAP: Record<string, HookKind> = {
  beforeSubmitPrompt: 'PROMPT',
  afterFileEdit: 'TOOL',
  postToolUse: 'TOOL',
  postToolUseFailure: 'TOOL_FAILED',
  afterAgentThought: 'NARRATION',
  afterAgentResponse: 'NARRATION',
  stop: 'TURN_END',
  preCompact: 'PRE_COMPACT',
  sessionStart: 'SESSION_START',
}

export function parseCursorHook(raw: RawHookPayload, ctx: AdapterContext): CaptureEvent | null {
  const eventName = asString(raw.hook_event_name) ?? ''
  const hook = CURSOR_HOOK_MAP[eventName]
  if (!hook) return null // unknown/future hook — ignore gracefully

  const base = baseCaptureFields(raw, 'cursor', hook, ctx)

  if (hook === 'PROMPT') {
    return {
      ...base,
      message: asString(raw.prompt) ?? asString(raw.text),
    }
  }

  if (hook === 'NARRATION') {
    return {
      ...base,
      message:
        asString(raw.text) ??
        asString(raw.message) ??
        asString(raw.content) ??
        asString(raw.thought),
      // afterAgentResponse is the turn-final summary; afterAgentThought is pre-edit reasoning.
      isClosing: eventName === 'afterAgentResponse',
    }
  }

  if (hook === 'TURN_END') {
    // Cursor's `stop` carries only { status, loop_count } — no message.
    // Narration is captured via afterAgentResponse/afterAgentThought (NARRATION).
    return { ...base, isFailure: asString(raw.status) === 'error' }
  }

  if (hook === 'TOOL' || hook === 'TOOL_FAILED') {
    const toolInput = toolInputFromRaw(raw) ?? {}
    if (asString(raw.file_path)) {
      toolInput.file_path = raw.file_path // afterFileEdit carries file_path at top level
    }
    if (Array.isArray(raw.edits)) {
      toolInput.edits = raw.edits // {old_string,new_string}[] → drives added/modified inference
    }
    return {
      ...base,
      toolName: asString(raw.tool_name) ?? 'Edit', // afterFileEdit has no tool_name; changeType inferred from edits
      toolInput,
      // Cursor: postToolUse → tool_output, postToolUseFailure → error_message
      toolResponse: raw.tool_output ?? raw.error_message,
      isFailure: hook === 'TOOL_FAILED' || statusIsError(raw),
    }
  }

  return base
}

function statusIsError(raw: RawHookPayload): boolean {
  return asString(raw.status) === 'error'
}

/** Concrete Strategy for Cursor. */
export const cursorAdapter: AgentAdapter = {
  source: 'cursor',
  parseHook: parseCursorHook,
  readTranscript: readCursorTranscript,
}

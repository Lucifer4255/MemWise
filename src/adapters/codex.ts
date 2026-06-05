import { readCodexRollout } from '../replay/codex-transcript.js'
import type { CaptureEvent, HookKind } from '../types.js'
import {
  asString,
  baseCaptureFields,
  isCodexToolFailure,
  toolInputFromRaw,
  type AdapterContext,
  type AgentAdapter,
  type RawHookPayload,
} from './common.js'

// Codex is schema-compatible with Claude Code (same hook names, same field shapes).
// Differences: no MessageDisplay (no mid-turn narration), turn_id on payloads,
// and failure detection via exit_code in tool_result rather than a separate event.
const CODEX_HOOK_MAP: Record<string, HookKind> = {
  UserPromptSubmit: 'PROMPT',
  PostToolUse: 'TOOL',
  PostToolUseFailure: 'TOOL_FAILED',
  PostToolBatch: 'TOOL_BATCH',
  // MessageDisplay is replay-only: Codex has no live narration hook, but the rollout transcript
  // carries assistant text, which readCodexRollout re-emits so segments get their intent.
  MessageDisplay: 'NARRATION',
  Stop: 'TURN_END',
  PreCompact: 'PRE_COMPACT',
  PostCompact: 'POST_COMPACT',
  SessionStart: 'SESSION_START',
}

export function parseCodexHook(raw: RawHookPayload, ctx: AdapterContext): CaptureEvent | null {
  const eventName = asString(raw.hook_event_name) ?? ''
  const hook = CODEX_HOOK_MAP[eventName]
  if (!hook) return null // unknown/future hook — ignore gracefully

  const base = baseCaptureFields(raw, 'codex', hook, ctx)

  if (hook === 'PROMPT') {
    return { ...base, message: asString(raw.prompt) }
  }

  if (hook === 'NARRATION') {
    // Replay-only (see CODEX_HOOK_MAP). Assistant text recovered from the rollout transcript.
    const text = asString(raw.text)
    if (!text) return null
    return { ...base, message: text }
  }

  if (hook === 'TURN_END') {
    // Schema-compatible with Claude Code: Stop carries last_assistant_message.
    return { ...base, message: asString(raw.last_assistant_message) }
  }

  if (hook === 'TOOL') {
    const failed = isCodexToolFailure(raw)
    return {
      ...base,
      hook: failed ? 'TOOL_FAILED' : 'TOOL',
      toolName: asString(raw.tool_name),
      toolInput: toolInputFromRaw(raw),
      toolResponse: failed ? asString(raw.error) ?? raw.tool_response : raw.tool_response,
      isFailure: failed,
    }
  }

  if (hook === 'TOOL_FAILED') {
    return {
      ...base,
      toolName: asString(raw.tool_name),
      toolInput: toolInputFromRaw(raw),
      toolResponse: asString(raw.error) ?? raw.tool_response,
      isFailure: true,
    }
  }

  return base
}

/** Concrete Strategy for Codex. */
export const codexAdapter: AgentAdapter = {
  source: 'codex',
  parseHook: parseCodexHook,
  readTranscript: readCodexRollout,
}

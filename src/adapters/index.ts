export { claudeCodeAdapter, parseClaudeCodeHook } from './claude-code.js'
export { codexAdapter, parseCodexHook } from './codex.js'
export { cursorAdapter, parseCursorHook } from './cursor.js'
export type {
  AdapterContext,
  AgentAdapter,
  AgentSource,
  RawHookPayload,
  ReplayEvent,
  TranscriptHint,
  TranscriptRead,
} from './common.js'

import type { CaptureEvent } from '../core/types.js'
import { claudeCodeAdapter } from './claude-code.js'
import { codexAdapter } from './codex.js'
import { cursorAdapter } from './cursor.js'
import type { AdapterContext, AgentAdapter, AgentSource, RawHookPayload } from './common.js'

/**
 * Registry (a Factory): selects the per-agent Strategy by source. Adding a new agent is one
 * entry here plus one concrete AgentAdapter — the capture pipeline doesn't change.
 */
const ADAPTERS: Record<AgentSource, AgentAdapter> = {
  'claude-code': claudeCodeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
}

export function getAdapter(source: AgentSource): AgentAdapter {
  return ADAPTERS[source]
}

// Returns null for non-final MessageDisplay deltas — caller should discard and wait
// for the final chunk before passing to BracketManager.
export function parseHook(
  source: CaptureEvent['source'],
  raw: RawHookPayload,
  ctx: AdapterContext,
): CaptureEvent | null {
  return getAdapter(source).parseHook(raw, ctx)
}

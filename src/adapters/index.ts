export { parseClaudeCodeHook } from './claude-code.js'
export { parseCodexHook } from './codex.js'
export { parseCursorHook } from './cursor.js'
export type { AdapterContext, RawHookPayload } from './common.js'

import type { CaptureEvent } from '../types.js'
import { parseClaudeCodeHook } from './claude-code.js'
import { parseCodexHook } from './codex.js'
import { parseCursorHook } from './cursor.js'
import type { AdapterContext, RawHookPayload } from './common.js'

// Returns null for non-final MessageDisplay deltas — caller should discard and wait
// for the final chunk before passing to BracketManager.
export function parseHook(
  source: CaptureEvent['source'],
  raw: RawHookPayload,
  ctx: AdapterContext,
): CaptureEvent | null {
  switch (source) {
    case 'claude-code':
      return parseClaudeCodeHook(raw, ctx)
    case 'codex':
      return parseCodexHook(raw, ctx)
    case 'cursor':
      return parseCursorHook(raw, ctx)
  }
}

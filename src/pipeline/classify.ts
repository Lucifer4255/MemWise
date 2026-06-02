import type { CaptureEvent } from '../types.js'

export type CaptureKind =
  | 'file_change'
  | 'file_access'   // Read/Glob/Grep/LS/List — adds to touched-set, no vector
  | 'command_ran'
  | 'command_failed'
  | 'session_goal'
  | 'agent_insight'
  | 'other'

// Read-only tools: pass through the pipeline but contribute only to the touched-set,
// not to code changes or vectors.
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'List'])

function hasFilePath(event: CaptureEvent): boolean {
  const input = event.toolInput
  if (!input) return false
  return typeof input.file_path === 'string' || typeof input.path === 'string'
}

export function classify(event: CaptureEvent): CaptureKind {
  if (event.hook === 'PROMPT') return 'session_goal'
  if (event.hook === 'NARRATION') return 'agent_insight'

  if (event.hook === 'TOOL_FAILED' || event.isFailure) {
    return 'command_failed'
  }

  if (event.hook === 'TOOL') {
    const tool = event.toolName ?? ''
    if (READ_TOOLS.has(tool)) return 'file_access'
    if (hasFilePath(event)) return 'file_change'
    if (tool === 'Bash' || tool === 'Shell') return 'command_ran'
    if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'apply_patch') {
      return 'file_change'
    }
  }

  return 'other'
}

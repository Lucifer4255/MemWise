import type { CaptureEvent } from '../types.js'

export type CaptureKind =
  | 'file_change'
  | 'command_ran'
  | 'command_failed'
  | 'session_goal'
  | 'agent_insight'
  | 'other'

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
    if (hasFilePath(event)) return 'file_change'
    const tool = event.toolName ?? ''
    if (tool === 'Bash' || tool === 'Shell') return 'command_ran'
    if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'apply_patch') {
      return 'file_change'
    }
  }

  return 'other'
}

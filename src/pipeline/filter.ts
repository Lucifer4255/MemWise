import type { CaptureEvent } from '../types.js'

const NOISE_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'List',
  'WebSearch',
  'WebFetch',
  'NotebookRead',
  'Task',
])

/** Returns true when the event should enter the capture pipeline. */
export function shouldCapture(event: CaptureEvent): boolean {
  if (event.hook !== 'TOOL' && event.hook !== 'TOOL_FAILED') {
    return true
  }

  const tool = event.toolName ?? ''
  if (NOISE_TOOLS.has(tool)) return false

  return true
}

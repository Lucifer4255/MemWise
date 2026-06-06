import type { CaptureEvent } from '../core/types.js'

// Read/Glob/Grep/LS/List pass through — they feed the bracket's touchedFiles set so
// cross-message parent_sig lineage (e.g. execution→plan) can wire up via file overlap.
// Web/notebook/task tools produce no useful signal for code memory, so drop them here.
const NOISE_TOOLS = new Set([
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

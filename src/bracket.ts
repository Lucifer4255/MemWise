import { computeSignature, resolveIntentText, worthStoringSegment } from './signature.js'
import type { Bracket, CaptureEvent, CodeChange, FinalizedSegment, Segment } from './types.js'
import { createEmptySegment } from './types.js'

// Key on sessionId ALONE — a session has one active turn at a time (PROMPT→…→Stop is
// sequential). turnId is NOT reliable across hooks: Claude Code only puts turn_id on
// MessageDisplay, not on UserPromptSubmit/PostToolUse/Stop, so keying on it would route
// narration to a different bucket than the bracket and silently drop it. turnId stays on
// the event/bracket as metadata. (Subagents are isolated via agent_id, handled elsewhere.)
function bracketKey(event: CaptureEvent): string {
  return event.sessionId
}

function projectIdFromPath(projectPath: string): string {
  return projectPath || 'unknown'
}

/** Minimal file-level change until Layer 4 tree-sitter supplies symbols. */
export function codeChangeFromToolEvent(event: CaptureEvent): CodeChange | null {
  if (event.hook !== 'TOOL' && event.hook !== 'TOOL_FAILED') return null
  const input = event.toolInput
  if (!input) return null

  const filePath =
    (typeof input.file_path === 'string' && input.file_path) ||
    (typeof input.path === 'string' && input.path) ||
    null

  if (!filePath) return null

  return {
    file: filePath,
    symbol: filePath,
    changeType: inferChangeType(event),
  }
}

function inferChangeType(event: CaptureEvent): CodeChange['changeType'] {
  // Cursor afterFileEdit gives an `edits: [{old_string, new_string}]` array with no
  // tool_name. A non-empty old_string means we replaced existing content (modified);
  // all-empty old_strings mean new content (added). This beats defaulting every Cursor
  // edit to 'added'. Falls back to the tool-name heuristic (Claude Code: Write=add, Edit=mod).
  const edits = (event.toolInput as Record<string, unknown> | undefined)?.edits
  if (Array.isArray(edits) && edits.length > 0) {
    const modifiesExisting = edits.some(e => {
      const old = (e as Record<string, unknown> | null)?.old_string
      return typeof old === 'string' && old.length > 0
    })
    return modifiesExisting ? 'modified' : 'added'
  }
  return event.toolName === 'Write' ? 'added' : 'modified'
}

export class BracketManager {
  private readonly open = new Map<string, Bracket>()
  private readonly fileToLastSig = new Map<string, string>()
  private readonly sigStoreOrder: string[] = []
  private readonly storedSigs = new Set<string>()
  private pendingIntent: string | null = null

  /** Last stored sig in this manager (session-global fallback for text-only segments). */
  private lastStoredSig: string | null = null

  handle(event: CaptureEvent): FinalizedSegment[] {
    switch (event.hook) {
      case 'PROMPT':
        this.openBracket(event)
        return []
      case 'NARRATION':
        this.handleNarration(event)
        return []
      case 'TOOL':
      case 'TOOL_FAILED':
        this.handleTool(event)
        return []
      case 'TOOL_BATCH':
        this.handleToolBatch()
        return []
      case 'TURN_END':
        return this.closeBracket(event)
      default:
        return []
    }
  }

  getOpenBracket(sessionId: string): Bracket | undefined {
    return this.open.get(sessionId)
  }

  private openBracket(event: CaptureEvent): void {
    const key = bracketKey(event)
    const segment = createEmptySegment(0)
    if (event.message?.trim()) {
      this.pendingIntent = event.message.trim()
      segment.intentText = this.pendingIntent
    }

    this.open.set(key, {
      promptText: event.message ?? '',
      segments: [segment],
      sessionId: event.sessionId,
      turnId: event.turnId ?? null,
      projectId: projectIdFromPath(event.projectPath),
      source: event.source,
      tsOpen: event.ts,
    })
  }

  private handleNarration(event: CaptureEvent): void {
    const bracket = this.open.get(bracketKey(event))
    if (!bracket) return

    const text = event.message?.trim()
    if (!text) return

    // Turn-final summary (Cursor afterAgentResponse): stash as the closing message and
    // apply at close. Do NOT open a new segment — it would create a spurious text-only
    // node after the real intents.
    if (event.isClosing) {
      bracket.closingMessage = text
      return
    }

    const current = this.currentSegment(bracket)
    if (current && current.codeChanges.length > 0) {
      this.startNewSegment(bracket, text)
    } else if (current) {
      current.intentText = text
      this.pushMessageChunk(current, text)
    }

    this.pendingIntent = text
  }

  private handleTool(event: CaptureEvent): void {
    const bracket = this.open.get(bracketKey(event))
    if (!bracket) return

    const change = codeChangeFromToolEvent(event)
    if (!change) return

    const segment = this.currentSegment(bracket)!
    if (!segment.intentText && this.pendingIntent) {
      segment.intentText = this.pendingIntent
      this.pushMessageChunk(segment, this.pendingIntent)
    }

    segment.codeChanges.push(change)
  }

  private handleToolBatch(): void {
    for (const bracket of this.open.values()) {
      const current = this.currentSegment(bracket)
      if (current && current.codeChanges.length > 0) {
        this.startNewSegment(bracket, this.pendingIntent)
      }
    }
  }

  private closeBracket(event: CaptureEvent): FinalizedSegment[] {
    const bracket = this.open.get(bracketKey(event))
    if (!bracket) return []

    // TURN_END message (Claude Code Stop.last_assistant_message) or, when the turn-end hook
    // carries none (Cursor stop), the stashed closing narration from afterAgentResponse.
    const closingMessage = event.message?.trim() || bracket.closingMessage
    const last = this.currentSegment(bracket)
    if (closingMessage && last) {
      if (!last.intentText) {
        last.intentText = closingMessage
      }
      this.pushMessageChunk(last, closingMessage)
    }

    const results: FinalizedSegment[] = []

    for (let i = 0; i < bracket.segments.length; i++) {
      const segment = bracket.segments[i]!
      segment.segmentIdx = i

      if (!segment.intentText && this.pendingIntent) {
        segment.intentText = this.pendingIntent
      }

      const worthStore = worthStoringSegment(segment)
      if (!worthStore) continue

      const files = [...new Set(segment.codeChanges.map(c => c.file))]
      segment.parentSig = this.resolveParentSig(files)
      segment.signature = computeSignature(
        bracket.promptText,
        segment.segmentIdx,
        segment.intentText,
        segment.codeChanges,
      )

      this.recordStored(segment.signature, files)
      results.push({ bracket, segment, worthStore: true })
    }

    this.open.delete(bracketKey(event))
    this.pendingIntent = null
    return results
  }

  private startNewSegment(bracket: Bracket, intentText: string | null): void {
    const nextIdx = bracket.segments.length
    const segment = createEmptySegment(nextIdx)
    if (intentText?.trim()) {
      segment.intentText = intentText.trim()
      this.pushMessageChunk(segment, intentText.trim())
    }
    bracket.segments.push(segment)
  }

  private currentSegment(bracket: Bracket): Segment | undefined {
    return bracket.segments[bracket.segments.length - 1]
  }

  private pushMessageChunk(segment: Segment, text: string): void {
    if (!text.trim()) return
    segment.messageChunks.push(text.trim())
  }

  private resolveParentSig(files: string[]): string | null {
    if (files.length === 0) {
      return this.lastStoredSig
    }

    const candidates = new Set<string>()
    for (const file of files) {
      const sig = this.fileToLastSig.get(file)
      if (sig) candidates.add(sig)
    }

    for (let i = this.sigStoreOrder.length - 1; i >= 0; i--) {
      const sig = this.sigStoreOrder[i]!
      if (candidates.has(sig)) return sig
    }

    return this.lastStoredSig
  }

  private recordStored(sig: string, files: string[]): void {
    if (this.storedSigs.has(sig)) return
    this.storedSigs.add(sig)
    this.sigStoreOrder.push(sig)
    this.lastStoredSig = sig
    for (const file of files) {
      this.fileToLastSig.set(file, sig)
    }
  }
}

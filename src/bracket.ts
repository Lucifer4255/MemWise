import { changesFromToolInput, type ResolvedChanges } from './parser/bridge.js'
import { computeMessageSig, worthStoringMessage } from './signature.js'
import type { Bracket, CaptureEvent, CodeChange, FinalizedMessage, Segment } from './types.js'
import { createEmptySegment } from './types.js'

const DOC_EXTENSIONS = new Set(['.md', '.txt', '.rst', '.mdx', '.markdown'])
function isDocFile(path: string): boolean {
  const dot = path.lastIndexOf('.')
  return dot !== -1 && DOC_EXTENSIONS.has(path.slice(dot).toLowerCase())
}

// Key on sessionId ALONE — a session has one active turn at a time (PROMPT→…→Stop is
// sequential). turnId is NOT reliable across hooks: Claude Code only puts turn_id on
// MessageDisplay, not on UserPromptSubmit/PostToolUse/Stop, so keying on it would route
// narration to a different bucket than the bracket and silently drop it. turnId stays on
// the event/bracket as metadata. (Subagents are isolated via agent_id, handled elsewhere.)
function bracketKey(event: CaptureEvent): string {
  return event.sessionId
}

import { projectIdFromPath } from './project.js'

// Read-only tools must not produce CodeChange rows — they contribute to touchedFiles only.
const READONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'List'])

/** Resolve a tool event to its code-change children + dependency edges.
 *  Returns one CodeChange PER changed symbol (tree-sitter), or a file-level row on any miss. */
export function codeChangesFromToolEvent(event: CaptureEvent): ResolvedChanges {
  if (event.hook !== 'TOOL' && event.hook !== 'TOOL_FAILED') return { changes: [], deps: [] }
  if (READONLY_TOOLS.has(event.toolName ?? '')) return { changes: [], deps: [] }
  const input = event.toolInput
  if (!input) return { changes: [], deps: [] }

  const filePath =
    (typeof input.file_path === 'string' && input.file_path) ||
    (typeof input.path === 'string' && input.path) ||
    null

  if (!filePath) return { changes: [], deps: [] }

  const changeType = inferChangeType(event)
  return changesFromToolInput(event.sessionId, filePath, input, changeType, event.projectPath)
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

  handle(event: CaptureEvent): FinalizedMessage | null {
    switch (event.hook) {
      case 'PROMPT':
        this.openBracket(event)
        return null
      case 'NARRATION':
        this.handleNarration(event)
        return null
      case 'TOOL':
      case 'TOOL_FAILED':
        this.handleTool(event)
        return null
      case 'TOOL_BATCH':
        this.handleToolBatch()
        return null
      case 'TURN_END':
        return this.closeBracket(event)
      default:
        return null
    }
  }

  getOpenBracket(sessionId: string): Bracket | undefined {
    return this.open.get(sessionId)
  }

  /** Record a file the agent READ (not wrote) during this turn — used for parent_sig
   *  resolution so cross-message lineage (e.g. execution reads plan.md → links to M1) wires. */
  addTouchedFile(event: CaptureEvent): void {
    const bracket = this.open.get(event.sessionId)
    if (!bracket) return
    const input = event.toolInput
    if (!input) return
    const file =
      (typeof input.file_path === 'string' && input.file_path) ||
      (typeof input.path === 'string' && input.path) ||
      null
    if (file && !bracket.touchedFiles.includes(file)) {
      bracket.touchedFiles.push(file)
    }
  }

  private openBracket(event: CaptureEvent): void {
    const key = bracketKey(event)
    const segment = createEmptySegment()
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
      touchedFiles: [],
      symbolDeps: [],
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

    const { changes, deps } = codeChangesFromToolEvent(event)
    if (changes.length === 0) return

    const segment = this.currentSegment(bracket)!
    if (!segment.intentText && this.pendingIntent) {
      segment.intentText = this.pendingIntent
      this.pushMessageChunk(segment, this.pendingIntent)
    }

    for (const change of changes) segment.codeChanges.push(change)
    bracket.symbolDeps.push(...deps)

    // Doc files: fold the written content into messageChunks (embedded, unlike code).
    const file = changes[0]!.file
    if (isDocFile(file) && event.toolInput) {
      const content =
        (typeof event.toolInput.content === 'string' && event.toolInput.content) ||
        (typeof event.toolInput.new_string === 'string' && event.toolInput.new_string) ||
        null
      if (content?.trim()) this.pushMessageChunk(segment, content.trim())
    }
  }

  private handleToolBatch(): void {
    for (const bracket of this.open.values()) {
      const current = this.currentSegment(bracket)
      if (current && current.codeChanges.length > 0) {
        this.startNewSegment(bracket, this.pendingIntent)
      }
    }
  }

  private closeBracket(event: CaptureEvent): FinalizedMessage | null {
    const bracket = this.open.get(bracketKey(event))
    if (!bracket) return null

    // Closing message: CC Stop.last_assistant_message or Cursor stashed afterAgentResponse.
    // Append to the last segment so it is pooled into contextText.
    const closingMessage = event.message?.trim() || bracket.closingMessage
    const last = this.currentSegment(bracket)
    if (closingMessage && last) {
      this.pushMessageChunk(last, closingMessage)
    }

    // Pool all segments into one message unit. The user's PROMPT leads the contextText so
    // the spine vector is anchored on the ask (and a code-only message still gets a vector).
    const allCodeChanges = bracket.segments.flatMap(s => s.codeChanges)
    const allChunks = bracket.segments.flatMap(s => s.messageChunks)
    const parts = [bracket.promptText, ...allChunks].map(s => s.trim()).filter(Boolean)
    // Cap contextText so a pathological session doesn't produce a 100k-token embedding.
    const contextText = parts.join('\n\n').slice(0, 6000)

    this.open.delete(bracketKey(event))
    this.pendingIntent = null

    if (!worthStoringMessage(allCodeChanges, contextText)) return null

    const sig = computeMessageSig(bracket.promptText, allCodeChanges)

    // parentSig: use code-change files ∪ touchedFiles so execution→plan links form
    // even when the message only creates new files (no prior sig for them in fileToLastSig).
    const allFiles = [...new Set([
      ...allCodeChanges.map(c => c.file),
      ...bracket.touchedFiles,
    ])]
    const parentSig = this.resolveParentSig(allFiles)

    // Record only code-change files for future parentSig resolution (not read-only touched).
    const codeFiles = [...new Set(allCodeChanges.map(c => c.file))]
    this.recordStored(sig, codeFiles)

    // Dedupe dependency edges accumulated across the turn's edits.
    const seenDep = new Set<string>()
    const symbolDeps = bracket.symbolDeps.filter(d => {
      const k = `${d.fromSymbol}\0${d.fromFile}\0${d.toSymbol}\0${d.toFile}`
      if (seenDep.has(k)) return false
      seenDep.add(k)
      return true
    })

    return {
      sig,
      parentSig,
      promptText: bracket.promptText,
      contextText,
      codeChanges: allCodeChanges,
      symbolDeps,
      projectId: bracket.projectId,
      sessionId: bracket.sessionId,
      source: bracket.source,
      tsOpen: bracket.tsOpen,
      ts: event.ts,
    }
  }

  private startNewSegment(bracket: Bracket, intentText: string | null): void {
    const segment = createEmptySegment()
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

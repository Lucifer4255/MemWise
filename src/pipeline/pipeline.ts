import { BracketManager } from '../bracket.js'
import { projectIdFromPath } from '../project.js'
import { pushHotChunk, updateChunkSig, type EvictHook } from '../redis.js'
import type { CaptureEvent } from '../types.js'
import { classify, type CaptureKind } from './classify.js'
import { chunkText } from './chunker.js'
import { isNewEvent } from './dedup.js'
import { shouldCapture } from './filter.js'
import { SeqCounter, type PipelineResult } from './seq.js'

function textForChunking(event: CaptureEvent, kind: CaptureKind): string | null {
  if (event.message?.trim()) return event.message.trim()

  if (kind === 'file_change' && event.toolInput) {
    const file =
      (typeof event.toolInput.file_path === 'string' && event.toolInput.file_path) ||
      (typeof event.toolInput.path === 'string' && event.toolInput.path) ||
      null
    if (file) return `Edited ${file}`
  }

  if (kind === 'command_ran' || kind === 'command_failed') {
    const cmd =
      typeof event.toolInput?.command === 'string' ? event.toolInput.command : event.toolName
    if (cmd) return `Ran command: ${cmd}`
  }

  return null
}

/** A chunk pushed during the current turn, tagged with the segment it belongs to. The
 *  segment's signature is only known at TURN_END, so we backfill `sig` onto these then. */
interface PendingChunk {
  seq: number
  segmentIdx: number
}

export class CapturePipeline {
  // chunks awaiting a signature, keyed by session (one open turn per session)
  private readonly pending = new Map<string, PendingChunk[]>()

  constructor(
    private readonly brackets: BracketManager = new BracketManager(),
    private readonly seq: SeqCounter = new SeqCounter(),
    private readonly onEvict?: EvictHook, // L5 injects the SQLite flush here
  ) {}

  get bracketManager(): BracketManager {
    return this.brackets
  }

  get seqCounter(): SeqCounter {
    return this.seq
  }

  async process(event: CaptureEvent): Promise<PipelineResult> {
    if (!shouldCapture(event)) {
      return { status: 'filtered', chunkKeys: [], finalized: [] }
    }

    if (!(await isNewEvent(event))) {
      return { status: 'duplicate', chunkKeys: [], finalized: [] }
    }

    if (!event.seq) {
      event.seq = this.seq.next(event.sessionId)
    }

    // A new prompt starts a fresh turn — drop any pending chunks from an unclosed prior turn
    // so their sigs can't be mislinked to this turn's segments.
    if (event.hook === 'PROMPT') this.pending.delete(event.sessionId)

    const kind = classify(event)
    const finalized = this.brackets.handle(event)
    const isTurnEnd = event.hook === 'TURN_END'

    // Which segment do chunks created by THIS event belong to?
    // - mid-turn: the bracket's current (last) segment
    // - TURN_END: the closing message attaches to the last finalized segment
    let segmentIdx = 0
    if (isTurnEnd) {
      segmentIdx = finalized.length > 0 ? finalized[finalized.length - 1]!.segment.segmentIdx : 0
    } else {
      const open = this.brackets.getOpenBracket(event.sessionId)
      segmentIdx = open ? open.segments.length - 1 : 0
    }

    const chunkKeys: string[] = []
    const pending = this.pending.get(event.sessionId) ?? []

    const rawText = textForChunking(event, kind)
    if (rawText) {
      const projectId = projectIdFromPath(event.projectPath)
      for (const text of chunkText(rawText)) {
        const seq = this.seq.next(event.sessionId)
        const key = await pushHotChunk(
          { sessionId: event.sessionId, projectId, seq, text, ts: event.ts },
          { onEvict: this.onEvict },
        )
        chunkKeys.push(key)
        pending.push({ seq, segmentIdx })
      }
    }
    this.pending.set(event.sessionId, pending)

    // At close, every finalized segment's signature is known — stamp it onto each of that
    // segment's chunks (the chunk → signature → "why" join). Then clear the turn's pending.
    if (isTurnEnd) {
      const sigByIdx = new Map<number, string>()
      for (const f of finalized) {
        if (f.segment.signature) sigByIdx.set(f.segment.segmentIdx, f.segment.signature)
      }
      for (const pc of this.pending.get(event.sessionId) ?? []) {
        const sig = sigByIdx.get(pc.segmentIdx)
        if (sig) await updateChunkSig(event.sessionId, pc.seq, sig)
      }
      this.pending.delete(event.sessionId)
    }

    return { status: 'ok', kind, chunkKeys, finalized }
  }
}

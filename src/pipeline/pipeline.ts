import { BracketManager } from '../bracket.js'
import { projectIdFromPath } from '../project.js'
import { pushHotChunk, type EvictHook } from '../redis.js'
import type { CaptureEvent } from '../types.js'
import { classify, type CaptureKind } from './classify.js'
import { isNewEvent } from './dedup.js'
import { shouldCapture } from './filter.js'
import { SeqCounter, type PipelineResult } from './seq.js'

export class CapturePipeline {
  constructor(
    private readonly brackets: BracketManager = new BracketManager(),
    private readonly seq: SeqCounter = new SeqCounter(),
    private readonly onEvict?: EvictHook,
  ) {}

  get bracketManager(): BracketManager {
    return this.brackets
  }

  get seqCounter(): SeqCounter {
    return this.seq
  }

  async process(event: CaptureEvent): Promise<PipelineResult> {
    if (!shouldCapture(event)) {
      return { status: 'filtered', chunkKeys: [], finalized: null }
    }

    if (!(await isNewEvent(event))) {
      return { status: 'duplicate', chunkKeys: [], finalized: null }
    }

    if (!event.seq) {
      event.seq = this.seq.next(event.sessionId)
    }

    const kind = classify(event)

    // Read-only tools feed the bracket's touched-set for cross-message parent_sig resolution.
    if (kind === 'file_access') this.brackets.addTouchedFile(event)

    const finalized = this.brackets.handle(event)

    // Only at TURN_END does the bracket finalize a message. Push ONE context chunk with the
    // sig already set — no backfill needed, no mid-turn noise vectors.
    if (finalized) {
      const chunkKeys: string[] = []
      if (finalized.contextText) {
        const seq = this.seq.next(finalized.sessionId)
        const key = await pushHotChunk(
          {
            sessionId: finalized.sessionId,
            projectId: finalized.projectId,
            seq,
            text: finalized.contextText,
            sig: finalized.sig,
            ts: finalized.ts,
          },
          { onEvict: this.onEvict },
        )
        chunkKeys.push(key)
      }
      return { status: 'ok', kind, chunkKeys, finalized }
    }

    return { status: 'ok', kind, chunkKeys: [], finalized: null }
  }
}

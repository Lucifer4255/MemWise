import { BracketManager } from '../bracket.js'
import { Embedder } from '../embed/embedder.js'
import { Flusher } from '../flush/flusher.js'
import { pushHotChunk, type EvictHook } from '../redis.js'
import type { SqliteStore } from '../store/sqlite-store.js'
import type { CaptureEvent } from '../types.js'
import { classify, type CaptureKind } from './classify.js'
import { isNewEvent } from './dedup.js'
import { shouldCapture } from './filter.js'
import { SeqCounter, type PipelineResult } from './seq.js'

export interface PipelineDeps {
  store?: SqliteStore
  embedder?: Embedder
  flusher?: Flusher
}

export class CapturePipeline {
  private readonly embedder: Embedder
  private readonly flusher: Flusher | null
  private readonly onEvict: EvictHook | undefined

  constructor(
    private readonly brackets: BracketManager = new BracketManager(),
    private readonly seq: SeqCounter = new SeqCounter(),
    deps: PipelineDeps = {},
  ) {
    this.embedder = deps.embedder ?? new Embedder()
    this.flusher = deps.store ? (deps.flusher ?? new Flusher(deps.store, this.embedder)) : null
    this.onEvict =
      this.flusher != null
        ? async (sessionId, seq) => {
            await this.flusher!.flushChunk(sessionId, seq)
          }
        : undefined
  }

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

    if (kind === 'file_access') this.brackets.addTouchedFile(event)

    const finalized = this.brackets.handle(event)

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
            finalized: {
              promptText: finalized.promptText,
              parentSig: finalized.parentSig,
              source: finalized.source,
              tsOpen: finalized.tsOpen,
              changesJson: JSON.stringify(finalized.codeChanges),
              depsJson: JSON.stringify(finalized.symbolDeps),
            },
          },
          { onEvict: this.onEvict },
        )
        this.embedder.scheduleEmbed(finalized.sessionId, seq, finalized.contextText)
        chunkKeys.push(key)
      }
      return { status: 'ok', kind, chunkKeys, finalized }
    }

    return { status: 'ok', kind, chunkKeys: [], finalized: null }
  }
}

/** Pipeline with SQLite flush-on-evict and async embed at TURN_END. */
export function createCapturePipeline(store: SqliteStore, deps: PipelineDeps = {}): CapturePipeline {
  const embedder = deps.embedder ?? new Embedder()
  const flusher = deps.flusher ?? new Flusher(store, embedder)
  return new CapturePipeline(undefined, undefined, { store, embedder, flusher })
}

export type { CaptureKind }

import type { CaptureKind } from './classify.js'
import type { FinalizedSegment } from '../types.js'

export class SeqCounter {
  private readonly counters = new Map<string, number>()

  next(sessionId: string): number {
    const n = (this.counters.get(sessionId) ?? 0) + 1
    this.counters.set(sessionId, n)
    return n
  }

  peek(sessionId: string): number {
    return this.counters.get(sessionId) ?? 0
  }

  reset(sessionId?: string): void {
    if (sessionId) this.counters.delete(sessionId)
    else this.counters.clear()
  }
}

export type PipelineStatus = 'ok' | 'filtered' | 'duplicate'

export interface PipelineResult {
  status: PipelineStatus
  kind?: CaptureKind
  chunkKeys: string[]
  finalized: FinalizedSegment[]
}

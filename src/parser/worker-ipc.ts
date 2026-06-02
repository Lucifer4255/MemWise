import { getTreeCache, parseIncrementalOrFallback } from './incremental.js'
import type { ParseJob, WorkerRequest, WorkerResponse } from './types.js'

const cache = getTreeCache()

function handleParse(id: number, job: ParseJob): WorkerResponse {
  const result = parseIncrementalOrFallback(job, cache)
  return { id, ok: true, result, stats: cache.stats() }
}

process.on('message', (msg: WorkerRequest) => {
  try {
    if (msg.type === 'parse') {
      process.send?.(handleParse(msg.id, msg.job))
      return
    }
    if (msg.type === 'stats') {
      process.send?.({ id: msg.id, ok: true, stats: cache.stats() })
      return
    }
    if (msg.type === 'shutdown') {
      process.send?.({ id: msg.id, ok: true, stats: cache.stats() })
      process.exit(0)
    }
  } catch (e) {
    process.send?.({
      id: msg.id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    })
  }
})

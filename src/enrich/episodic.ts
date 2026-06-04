import { EPISODIC_MIN_NEW_CHUNKS } from '../config.js'
import { GenerateClient } from '../embed/generate-client.js'
import { ENRICH_ENABLED, ENRICH_TIMEOUT_MS } from '../config.js'
import type { Enricher } from './enricher.js'
import type { SqliteStore } from '../store/sqlite-store.js'

const SYSTEM = [
  'You merge coding-session notes into ONE compact "what has been happening" recap for a future agent.',
  'Rules: be factual, name files/features/decisions, no markdown headers, a short paragraph or a few lines.',
  'Do not invent anything not present in the input.',
].join('\n')

export interface ConsolidateOpts {
  minNewChunks?: number
  /** Only used to detect "is a model available" cheaply; the merge uses its own GenerateClient. */
  enricher?: Enricher
  client?: GenerateClient
}

/**
 * Job 2 — episodic consolidation. When enough new chunks have landed since the last cross-window
 * (nightshift) summary, merge recent postcompact summaries + recent enriched context into one
 * nightshift `session_summary`. Graceful: no model / error → no-op (leaves the postcompact rows,
 * which `queryLatestSessionSummary` still falls back to).
 */
export async function maybeConsolidate(
  store: SqliteStore,
  projectId: string,
  opts: ConsolidateOpts = {},
): Promise<boolean> {
  const minNew = opts.minNewChunks ?? EPISODIC_MIN_NEW_CHUNKS
  const latest = store.queryLatestSessionSummary(projectId)
  const sinceTs = latest && latest.source === 'nightshift' ? latest.ts : 0

  if (store.countChunksSince(projectId, sinceTs) < minNew) return false

  const client = opts.client ?? new GenerateClient()
  if (ENRICH_ENABLED === 'off') return false
  if (ENRICH_ENABLED === 'auto' && !(await client.isAvailable())) return false

  const summaries = store.queryRecentSessionSummaries(projectId, 5)
  const chunks = store.queryRecentChunks(projectId, 12)
  const material = [
    ...summaries.map(s => `[summary] ${s.summary}`),
    ...chunks.map(c => `[note] ${c.text}`),
  ].join('\n\n')
  if (!material.trim()) return false

  try {
    const merged = (
      await client.generate(`Notes from recent work:\n\n${material}\n\nWrite the recap:`, SYSTEM, ENRICH_TIMEOUT_MS)
    ).trim()
    if (!merged) return false
    store.insertSessionSummary({
      projectId,
      source: 'nightshift',
      sigRange: '',
      summary: merged,
      ts: Date.now(),
    })
    store.insertTelemetry('job2', {
      projectId,
      inputs: summaries.length + chunks.length,
      chars: merged.length,
    })
    return true
  } catch {
    return false
  }
}

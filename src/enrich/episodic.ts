import { createHash } from 'node:crypto'
import { EPISODIC_MIN_NEW_CHUNKS } from '../core/config.js'
import { GenerateClient } from '../embed/generate-client.js'
import { ENRICH_ENABLED, ENRICH_TIMEOUT_MS } from '../core/config.js'
import { defaultOllamaEmbed, type EmbedFn } from '../embed/ollama-client.js'
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
  /** Embeds the merged summary so the session becomes a vector-searchable graph node (Layer 14). */
  embedFn?: EmbedFn
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

    // Layer 14: write the consolidated recap as a SESSION GRAPH NODE (Tier 3) — not just a flat row.
    // node_sig is keyed by the member-turn span so an identical window updates ONE node; a new window
    // (more work done) creates a new session node. The node carries the summary's embedding (so it's
    // vector-searchable for coarse-to-fine retrieval) and `summarizes` edges to its member turns.
    const members = [...chunks].sort((a, b) => a.ts - b.ts) // chronological
    const memberSigs = [...new Set(members.map(c => c.sig))]
    const sigRange =
      memberSigs.length > 0 ? `${memberSigs[0]}..${memberSigs[memberSigs.length - 1]}` : ''
    const nodeSig = `sess:${createHash('sha256').update(`${projectId}|${sigRange}`).digest('hex').slice(0, 16)}`
    const ts = Date.now()

    // Embedding is best-effort: if the embedder is unavailable, store the node vector-less (it still
    // participates as a graph node via summarizes edges; a catch-up embed can fill the vector later).
    let embedding: number[] = []
    try {
      embedding = await (opts.embedFn ?? defaultOllamaEmbed)(merged)
    } catch {
      embedding = []
    }

    store.upsertSessionNode(
      { nodeSig, projectId, source: 'nightshift', sigRange, summary: merged, ts },
      embedding,
    )
    for (const sig of memberSigs) {
      store.insertTurnEdgeOrIgnore({ fromSig: nodeSig, toSig: sig, edgeType: 'summarizes', label: '', ts })
    }
    store.insertTelemetry('job2', {
      projectId,
      inputs: summaries.length + chunks.length,
      members: memberSigs.length,
      embedded: embedding.length > 0,
      chars: merged.length,
    })
    return true
  } catch {
    return false
  }
}

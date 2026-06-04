import { RETRIEVE_HYBRID_LIMIT } from '../config.js'
import { fuseRankedLists } from '../rrf.js'
import type { MemoryStore } from '../store/memory-store.js'
import type { AnchorHit, RetrieveOptions } from './types.js'

export interface SearchAnchorsOpts {
  projectId: string
  query: string
  embedding: number[]
  store: MemoryStore
  limit?: number
}

/**
 * Cold (SQLite-only) hybrid search. Since capture writes directly to SQLite at turn end, there is
 * no separate hot window — everything queryable is already in the cold store, including the most
 * recent turn. Vector + FTS candidates are fused with RRF, then hydrated into anchors.
 */
export function searchAnchors(opts: SearchAnchorsOpts): AnchorHit[] {
  const limit = opts.limit ?? RETRIEVE_HYBRID_LIMIT
  const cold = opts.store.queryHybridScoped(opts.projectId, opts.embedding, opts.query, limit)
  if (cold.length === 0) return []

  // queryHybridScoped already fuses vec+FTS internally; keep the RRF call for a stable contract.
  const fusedSigs = fuseRankedLists([cold.map(c => c.sig)], limit)
  const bySig = new Map(cold.map(c => [c.sig, c]))

  const hits: AnchorHit[] = []
  for (const sig of fusedSigs) {
    const chunk = bySig.get(sig)
    hits.push({
      sig,
      text: chunk?.text ?? '',
      ts: chunk?.ts ?? 0,
      sources: ['cold'],
    })
  }
  return hits
}

export function searchRecentAnchors(
  store: MemoryStore,
  projectId: string,
  limit: number,
): AnchorHit[] {
  const chunks = store.queryRecentChunks(projectId, limit)
  return chunks.map(c => ({
    sig: c.sig,
    text: c.text,
    ts: c.ts,
    sources: ['recency'],
  }))
}

export function searchAnchorsFromOpts(
  opts: RetrieveOptions & { projectId: string; query: string; embedding: number[]; store: MemoryStore },
): AnchorHit[] {
  return searchAnchors({
    projectId: opts.projectId,
    query: opts.query,
    embedding: opts.embedding,
    store: opts.store,
    limit: opts.hybridLimit,
  })
}

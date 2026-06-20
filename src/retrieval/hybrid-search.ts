import { RETRIEVE_HYBRID_LIMIT } from '../core/config.js'
import { fuseRankedLists } from '../core/rrf.js'
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
// Max edges to inspect per candidate when scoring graph proximity (bounded, hot-path safe).
const PROXIMITY_EDGE_FANOUT = 16

/**
 * Layer 14 — graph-proximity rank: a THIRD RRF signal beside vector + FTS. Re-orders the SAME
 * candidate set (introduces nothing new) by how connected each candidate is to the OTHERS via
 * turn_edge (file/symbol/forward). A turn wired into the relevant neighbourhood is more likely
 * load-bearing than an isolated lexical match. On edge-less corpora this returns the input order
 * unchanged (no-op), so it never hurts — it only breaks ties toward graph-central turns.
 */
export function graphProximityRank(store: MemoryStore, candidateSigs: string[]): string[] {
  if (candidateSigs.length <= 1) return candidateSigs
  const candidates = new Set(candidateSigs)
  const score = new Map<string, number>()
  for (const sig of candidateSigs) {
    let connections = 0
    for (const e of store.getEdgeNeighbors(sig, PROXIMITY_EDGE_FANOUT)) {
      const neighbor = e.fromSig === sig ? e.toSig : e.fromSig
      if (candidates.has(neighbor)) connections++
    }
    score.set(sig, connections)
  }
  // Stable sort: ties preserve the incoming (content-relevance) order.
  return [...candidateSigs].sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0))
}

export function searchAnchors(opts: SearchAnchorsOpts): AnchorHit[] {
  const limit = opts.limit ?? RETRIEVE_HYBRID_LIMIT
  const cold = opts.store.queryHybridScoped(opts.projectId, opts.embedding, opts.query, limit)
  if (cold.length === 0) return []

  // Three-signal RRF: queryHybridScoped fuses vector+FTS into one content rank; graphProximityRank
  // is the third list. Fusing the two rewards candidates strong on BOTH content AND graph centrality.
  const contentSigs = cold.map(c => c.sig)
  const graphSigs = graphProximityRank(opts.store, contentSigs)
  const fusedSigs = fuseRankedLists([contentSigs, graphSigs], limit)
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

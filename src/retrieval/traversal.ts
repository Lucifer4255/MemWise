import type { Change, ContextChunk, MemoryStore, PromptSig, SymbolDep } from '../store/memory-store.js'
import type { AnchorHit, ContextBundle, RetrieveMode } from './types.js'

const PARENT_CHAIN_DEPTH = 8
// Max edges to fetch per anchor when expanding the turn graph (keeps retrieval bounded).
const EDGE_NEIGHBORS_PER_ANCHOR = 8
// Total connected chunks added to the bundle (caps context blowup).
const MAX_CONNECTED_CHUNKS = 6

export interface ExpandOpts {
  store: MemoryStore
  anchors: AnchorHit[]
  mode: RetrieveMode
  symbols?: string[]
}

export function expandAnchors(opts: ExpandOpts): ContextBundle {
  const { store, anchors, mode, symbols } = opts
  const changes = new Map<string, Change>()
  const chunks = new Map<string, ContextChunk>()
  const parentChains: PromptSig[][] = []
  const symbolChanges = new Map<string, Change>()
  const watchEdges = new Map<string, SymbolDep>()

  const anchorSigs = new Set(anchors.map(a => a.sig))

  for (const anchor of anchors) {
    const sqlChanges = store.getChangesForSig(anchor.sig)
    for (const c of sqlChanges) {
      changes.set(`${c.sig}:${c.file}:${c.symbol}`, c)
    }
    const chunk = store.getContextChunkBySig(anchor.sig)
    if (chunk) chunks.set(chunk.id, chunk)

    const chain = store.getParentChain(anchor.sig, PARENT_CHAIN_DEPTH)
    if (chain.length) parentChains.push(chain)
  }

  if (mode === 'symbol' && symbols) {
    for (const sym of symbols) {
      for (const c of store.queryChangesForSymbol(sym)) {
        symbolChanges.set(`${c.sig}:${c.file}:${c.symbol}`, c)
        const blast = store.queryBlastRadius(sym, c.file, 3)
        for (const edge of blast) {
          watchEdges.set(`${edge.fromSymbol}:${edge.fromFile}->${edge.toSymbol}:${edge.toFile}`, edge)
        }
      }
    }
  } else {
    // Only expand blast radius for changes whose file/symbol appear in the anchor's context text,
    // not for every change in the turn — prevents noisy expansion on large multi-file turns.
    const anchorTexts = anchors.map(a => a.text.toLowerCase())
    for (const c of [...changes.values()]) {
      const relevant = anchorTexts.some(
        t => t.includes(c.symbol.toLowerCase()) || t.includes(c.file.toLowerCase()),
      )
      if (!relevant) continue
      const blast = store.queryBlastRadius(c.symbol, c.file, 3)
      for (const edge of blast) {
        watchEdges.set(`${edge.fromSymbol}:${edge.fromFile}->${edge.toSymbol}:${edge.toFile}`, edge)
      }
    }
  }

  // ── turn-graph expansion (v6) ─────────────────────────────────────────────────────────────
  // For each anchor, follow its file/symbol/forward edges to find connected turns that weren't
  // returned by the vector/FTS search. This surfaces related history regardless of semantic
  // similarity — a file touched 60 turns ago is reachable without relying on the embedding.
  const connectedChunks: ContextChunk[] = []
  const seen = new Set<string>(anchorSigs)
  // Also skip sigs already in parent chains (they're in the "Why" section already).
  for (const chain of parentChains) {
    for (const p of chain) seen.add(p.sig)
  }

  outer: for (const anchor of anchors) {
    const edges = store.getEdgeNeighbors(anchor.sig, EDGE_NEIGHBORS_PER_ANCHOR)
    for (const edge of edges) {
      const neighborSig = edge.fromSig === anchor.sig ? edge.toSig : edge.fromSig
      if (seen.has(neighborSig)) continue
      seen.add(neighborSig)
      const chunk = store.getContextChunkBySig(neighborSig)
      if (chunk) {
        connectedChunks.push(chunk)
        if (connectedChunks.length >= MAX_CONNECTED_CHUNKS) break outer
      }
    }
  }

  return {
    anchors,
    changes: [...changes.values()],
    chunks: [...chunks.values()],
    parentChains,
    symbolChanges: [...symbolChanges.values()],
    watchEdges: [...watchEdges.values()],
    connectedChunks,
    mode,
  }
}

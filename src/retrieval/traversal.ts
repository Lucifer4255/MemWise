import type { Change, ContextChunk, MemoryStore, PromptSig, SymbolDep } from '../store/memory-store.js'
import type { AnchorHit, ContextBundle, RouteResult } from './types.js'

const PARENT_CHAIN_DEPTH = 8

export interface ExpandOpts {
  store: MemoryStore
  anchors: AnchorHit[]
  route: RouteResult
}

export function expandAnchors(opts: ExpandOpts): ContextBundle {
  const { store, anchors, route } = opts
  const changes = new Map<string, Change>()
  const chunks = new Map<string, ContextChunk>()
  const parentChains: PromptSig[][] = []
  const symbolChanges = new Map<string, Change>()
  const watchEdges = new Map<string, SymbolDep>()

  for (const anchor of anchors) {
    for (const c of store.getChangesForSig(anchor.sig)) {
      changes.set(`${c.sig}:${c.file}:${c.symbol}`, c)
    }
    const chunk = store.getContextChunkBySig(anchor.sig)
    if (chunk) chunks.set(chunk.id, chunk)

    const chain = store.getParentChain(anchor.sig, PARENT_CHAIN_DEPTH)
    if (chain.length) parentChains.push(chain)
  }

  if (route.mode === 'symbol' && route.symbols) {
    for (const sym of route.symbols) {
      for (const c of store.queryChangesForSymbol(sym)) {
        symbolChanges.set(`${c.sig}:${c.file}:${c.symbol}`, c)
        const blast = store.queryBlastRadius(sym, c.file, 3)
        for (const edge of blast) {
          watchEdges.set(`${edge.fromSymbol}:${edge.fromFile}->${edge.toSymbol}:${edge.toFile}`, edge)
        }
      }
    }
  } else {
    for (const c of [...changes.values()]) {
      const blast = store.queryBlastRadius(c.symbol, c.file, 3)
      for (const edge of blast) {
        watchEdges.set(`${edge.fromSymbol}:${edge.fromFile}->${edge.toSymbol}:${edge.toFile}`, edge)
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
    mode: route.mode,
  }
}

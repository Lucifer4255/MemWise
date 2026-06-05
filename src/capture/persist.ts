import type { Change, ContextChunk, PromptSig, SymbolDep, TurnEdge } from '../store/memory-store.js'
import type { SqliteStore } from '../store/sqlite-store.js'
import type { FinalizedMessage } from '../types.js'

/**
 * The single atomic write for one captured message: prompt_sig + change rows + symbol_dep edges +
 * context_chunk (+ its vector). All four commit together — a partial spine on crash would orphan
 * prompt_sig rows or duplicate change/dep rows on retry. `enriched`/`embedded` flags ride on the
 * chunk. An empty `embedding` writes the row vector-less (FTS-only) for a later catch-up embed.
 */
/**
 * Derive the turn_edge rows for a newly captured message.
 *
 * Three edge types, all written into the same transaction as the turn itself:
 *   'forward'  parent → this turn  (makes the spine traversable in both directions)
 *   'file'     this turn → most recent prior turn that touched the same file
 *   'symbol'   this turn → most recent prior turn that touched the same symbol
 *
 * File and symbol edges form per-file / per-symbol linked lists (not full pairwise graphs), so
 * total edge count stays O(n) and full history is reachable by following the chain.
 */
function deriveTurnEdges(store: SqliteStore, msg: FinalizedMessage, changes: Change[]): TurnEdge[] {
  const edges: TurnEdge[] = []
  const { sig, parentSig, projectId, ts } = msg

  if (parentSig) {
    edges.push({ fromSig: parentSig, toSig: sig, edgeType: 'forward', label: '', ts })
  }

  const seenFiles = new Set<string>()
  const seenSymbols = new Set<string>()

  for (const c of changes) {
    if (c.file && !seenFiles.has(c.file)) {
      seenFiles.add(c.file)
      const prev = store.getPriorTurnForFile(c.file, projectId, sig)
      if (prev) edges.push({ fromSig: sig, toSig: prev, edgeType: 'file', label: c.file, ts })
    }
    if (c.symbol && c.symbol !== '<file>' && !seenSymbols.has(c.symbol)) {
      seenSymbols.add(c.symbol)
      const prev = store.getPriorTurnForSymbol(c.symbol, projectId, sig)
      if (prev) edges.push({ fromSig: sig, toSig: prev, edgeType: 'symbol', label: c.symbol, ts })
    }
  }

  return edges
}

export function persistMessage(
  store: SqliteStore,
  msg: FinalizedMessage,
  text: string,
  embedding: number[],
  enriched: boolean,
): void {
  const promptSig: PromptSig = {
    sig: msg.sig,
    parentSig: msg.parentSig,
    promptText: msg.promptText,
    sessionId: msg.sessionId,
    source: msg.source,
    projectId: msg.projectId,
    ts: msg.ts,
  }
  const changes: Change[] = msg.codeChanges.map(c => ({
    sig: msg.sig,
    file: c.file,
    symbol: c.symbol,
    changeType: c.changeType,
  }))
  const deps: SymbolDep[] = msg.symbolDeps
  const chunk: ContextChunk = {
    id: `${msg.sig}:ctx`,
    sig: msg.sig,
    text,
    projectId: msg.projectId,
    ts: msg.ts,
    enriched,
  }

  store.runTransaction(() => {
    store.insertPromptSigOrIgnore(promptSig)
    for (const c of changes) store.insertChange(c)
    for (const d of deps) store.insertSymbolDep(d)
    store.insertContextChunk(chunk, embedding)
    for (const edge of deriveTurnEdges(store, msg, changes)) store.insertTurnEdgeOrIgnore(edge)
  })
}

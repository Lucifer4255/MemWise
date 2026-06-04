import type { Change, ContextChunk, PromptSig, SymbolDep } from '../store/memory-store.js'
import type { SqliteStore } from '../store/sqlite-store.js'
import type { FinalizedMessage } from '../types.js'

/**
 * The single atomic write for one captured message: prompt_sig + change rows + symbol_dep edges +
 * context_chunk (+ its vector). All four commit together — a partial spine on crash would orphan
 * prompt_sig rows or duplicate change/dep rows on retry. `enriched`/`embedded` flags ride on the
 * chunk. An empty `embedding` writes the row vector-less (FTS-only) for a later catch-up embed.
 */
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
  })
}

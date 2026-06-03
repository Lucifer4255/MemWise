import { Embedder } from '../embed/embedder.js'
import { bufferToEmbedding } from '../embed/vector.js'
import {
  deleteHotChunk,
  listHotChunkSeqs,
  readChunkEmbedding,
  readHotChunk,
  type HotChunkRecord,
} from '../redis.js'
import type { SqliteStore } from '../store/sqlite-store.js'
import type { Change, ContextChunk, PromptSig, Source, SymbolDep } from '../store/memory-store.js'
import type { CodeChange } from '../types.js'

export class Flusher {
  constructor(
    private readonly store: SqliteStore,
    private readonly embedder: Embedder = new Embedder(),
  ) {}

  /** Flush one hot chunk to SQLite, then delete from Redis. Returns false if chunk missing. */
  async flushChunk(sessionId: string, seq: number): Promise<boolean> {
    const raw = await readHotChunk(sessionId, seq)
    if (!raw) return false

    const parsed = parseStashedChunk(raw, sessionId)
    if (!parsed) return false

    let embedding = await this.readStashedEmbedding(raw, sessionId, seq)
    if (!embedding) {
      embedding = await this.embedder.embedChunk(sessionId, seq, parsed.contextChunk.text)
    }

    this.persistSpine(parsed.promptSig, parsed.changes, parsed.symbolDeps, parsed.contextChunk, embedding)
    await deleteHotChunk(sessionId, seq)
    return true
  }

  /** Flush all chunks in a session (oldest first). Returns count flushed. */
  async flushSession(sessionId: string): Promise<number> {
    const seqs = await listHotChunkSeqs(sessionId)
    let count = 0
    for (const seq of seqs) {
      if (await this.flushChunk(sessionId, seq)) count++
    }
    return count
  }

  /** Read the embedding written in-place at TURN_END, as raw bytes (never hgetall — see redis.ts). */
  private async readStashedEmbedding(
    raw: HotChunkRecord,
    sessionId: string,
    seq: number,
  ): Promise<number[] | null> {
    if (raw.embedded !== '1') return null
    const buf = await readChunkEmbedding(sessionId, seq)
    if (!buf) return null
    return bufferToEmbedding(buf, buf.length / 4)
  }

  /** All four spine writes commit atomically — a partial spine on crash would duplicate
   *  change/dep rows on the retry, and orphan prompt_sig rows with no context. */
  private persistSpine(
    sig: PromptSig,
    changes: Change[],
    deps: SymbolDep[],
    chunk: ContextChunk,
    embedding: number[],
  ): void {
    this.store.runTransaction(() => {
      this.store.insertPromptSigOrIgnore(sig)
      for (const c of changes) this.store.insertChange(c)
      for (const d of deps) this.store.insertSymbolDep(d)
      this.store.insertContextChunk(chunk, embedding)
    })
  }
}

interface ParsedStash {
  promptSig: PromptSig
  changes: Change[]
  symbolDeps: SymbolDep[]
  contextChunk: ContextChunk
}

function parseStashedChunk(raw: HotChunkRecord, sessionId: string): ParsedStash | null {
  const sig = raw.sig
  const text = raw.text
  const projectId = raw.project
  const ts = Number(raw.ts)
  if (!sig || !text || !projectId || !ts) return null

  const promptText = raw.prompt_text ?? text
  const parentSig = raw.parent_sig && raw.parent_sig.length > 0 ? raw.parent_sig : null
  const source = (raw.source ?? 'claude-code') as Source

  let codeChanges: CodeChange[] = []
  let symbolDeps: SymbolDep[] = []
  try {
    if (raw.changes_json) codeChanges = JSON.parse(raw.changes_json) as CodeChange[]
    if (raw.deps_json) symbolDeps = JSON.parse(raw.deps_json) as SymbolDep[]
  } catch {
    return null
  }

  const promptSig: PromptSig = {
    sig,
    parentSig,
    promptText,
    sessionId: raw.session ?? sessionId,
    source,
    projectId,
    ts,
  }

  const changes: Change[] = codeChanges.map(c => ({
    sig,
    file: c.file,
    symbol: c.symbol,
    changeType: c.changeType,
  }))

  const contextChunk: ContextChunk = {
    id: `${sig}:ctx`,
    sig,
    text,
    projectId,
    ts,
  }

  return { promptSig, changes, symbolDeps, contextChunk }
}

import type Database from 'better-sqlite3'
import { embeddingToBuffer } from '../embed/vector.js'
import { fuseRankedLists } from '../rrf.js'
import type {
  Change,
  ContextChunk,
  MemoryStore,
  PromptSig,
  Source,
  SymbolDep,
} from './memory-store.js'

export function contextChunkIdForSig(sig: string): string {
  return `${sig}:ctx`
}
// Hard cap on blast-radius rows so a densely-connected (diamond) dep graph can't
// expand without bound before the final DISTINCT (spec §11: DISTINCT + LIMIT).
const MAX_BLAST_ROWS = 500

type PromptSigRow = {
  sig: string
  parent_sig: string | null
  prompt_text: string
  session_id: string
  source: string
  project_id: string
  ts: number
}

type ChangeRow = {
  sig: string
  file: string
  symbol: string
  change_type: string
}

type ContextChunkRow = {
  id: string
  sig: string
  text: string
  project_id: string
  ts: number
}

type SymbolDepRow = {
  from_symbol: string
  from_file: string
  to_symbol: string
  to_file: string
}

function rowToPromptSig(row: PromptSigRow): PromptSig {
  return {
    sig: row.sig,
    parentSig: row.parent_sig,
    promptText: row.prompt_text,
    sessionId: row.session_id,
    source: row.source as Source,
    projectId: row.project_id,
    ts: row.ts,
  }
}

function rowToChange(row: ChangeRow): Change {
  return {
    sig: row.sig,
    file: row.file,
    symbol: row.symbol,
    changeType: row.change_type as Change['changeType'],
  }
}

function rowToContextChunk(row: ContextChunkRow): ContextChunk {
  return {
    id: row.id,
    sig: row.sig,
    text: row.text,
    projectId: row.project_id,
    ts: row.ts,
  }
}

function rowToSymbolDep(row: SymbolDepRow): SymbolDep {
  return {
    fromSymbol: row.from_symbol,
    fromFile: row.from_file,
    toSymbol: row.to_symbol,
    toFile: row.to_file,
  }
}

function ftsQuery(keywords: string): string {
  const trimmed = keywords.trim()
  if (!trimmed) return ''
  // Quote tokens that contain FTS special characters; otherwise pass through.
  // Join with OR (not the FTS5 default implicit AND): in hybrid retrieval we want
  // recall — a chunk matching ANY keyword is a candidate, and RRF + BM25 rank it.
  // Requiring every term (AND) silently drops good partial matches.
  const tokens = trimmed.split(/\s+/).filter(Boolean)
  return tokens
    .map(token => {
      if (/["*():^]/.test(token)) return `"${token.replace(/"/g, '""')}"`
      return token
    })
    .join(' OR ')
}

export class SqliteStore implements MemoryStore {
  constructor(private readonly db: Database.Database) {}

  /** Run `fn` inside a single transaction (nested calls use SAVEPOINTs via better-sqlite3). */
  runTransaction(fn: () => void): void {
    this.db.transaction(fn)()
  }

  insertPromptSig(sig: PromptSig): void {
    this.insertPromptSigOrIgnore(sig)
  }

  insertPromptSigOrIgnore(sig: PromptSig): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO prompt_sig (
          sig, parent_sig, prompt_text, session_id, source, project_id, ts
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sig.sig,
        sig.parentSig,
        sig.promptText,
        sig.sessionId,
        sig.source,
        sig.projectId,
        sig.ts,
      )
  }

  getPromptSig(sig: string): PromptSig | undefined {
    const row = this.db
      .prepare(
        `SELECT sig, parent_sig, prompt_text, session_id, source, project_id, ts
         FROM prompt_sig WHERE sig = ?`,
      )
      .get(sig) as PromptSigRow | undefined
    return row ? rowToPromptSig(row) : undefined
  }

  insertChange(change: Change): void {
    // OR IGNORE against uniq_change: a repeated sig (or a re-flush) must not duplicate edits.
    this.db
      .prepare(
        `INSERT OR IGNORE INTO change (sig, file, symbol, change_type)
         VALUES (?, ?, ?, ?)`,
      )
      .run(change.sig, change.file, change.symbol, change.changeType)
  }

  insertSymbolDep(dep: SymbolDep): void {
    // OR IGNORE against uniq_symbol_dep: the same edge can be (re)discovered across messages;
    // store it once so blast-radius traversal isn't bloated with duplicate edges.
    this.db
      .prepare(
        `INSERT OR IGNORE INTO symbol_dep (from_symbol, from_file, to_symbol, to_file)
         VALUES (?, ?, ?, ?)`,
      )
      .run(dep.fromSymbol, dep.fromFile, dep.toSymbol, dep.toFile)
  }

  insertContextChunk(chunk: ContextChunk, embedding: number[]): void {
    const insert = this.db.transaction(() => {
      // sig is a deterministic join key that can repeat (identical no-op prompts), so the
      // chunk id (`${sig}:ctx`) can collide. OR IGNORE keeps the flush idempotent; only mirror
      // the vector when the row was actually inserted, or chunk_vec would gain a duplicate.
      const res = this.db
        .prepare(
          `INSERT OR IGNORE INTO context_chunk (id, sig, text, project_id, ts)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(chunk.id, chunk.sig, chunk.text, chunk.projectId, chunk.ts)

      if (res.changes === 0) return

      this.db
        .prepare(`INSERT INTO chunk_vec (chunk_id, embedding) VALUES (?, ?)`)
        .run(chunk.id, embeddingToBuffer(embedding))
    })

    insert()
  }

  queryHybrid(embedding: number[], keywords: string, limit: number): ContextChunk[] {
    const vecRanked = this.queryVector(embedding, limit)
    const ftsRanked = this.queryFts(keywords, limit)
    const orderedIds = fuseRankedLists([vecRanked, ftsRanked], limit)
    return this.loadContextChunksById(orderedIds)
  }

  queryHybridScoped(
    projectId: string,
    embedding: number[],
    keywords: string,
    limit: number,
  ): ContextChunk[] {
    const vecRanked = this.queryVectorScoped(projectId, embedding, limit)
    const ftsRanked = this.queryFtsScoped(projectId, keywords, limit)
    const orderedIds = fuseRankedLists([vecRanked, ftsRanked], limit)
    return this.loadContextChunksById(orderedIds)
  }

  queryRecentChunks(projectId: string, limit: number): ContextChunk[] {
    if (limit <= 0) return []
    const rows = this.db
      .prepare(
        `SELECT id, sig, text, project_id, ts
         FROM context_chunk
         WHERE project_id = ?
         ORDER BY ts DESC
         LIMIT ?`,
      )
      .all(projectId, limit) as ContextChunkRow[]
    return rows.map(rowToContextChunk)
  }

  queryRecentPromptSigs(projectId: string, limit: number): PromptSig[] {
    if (limit <= 0) return []
    // Project-scoped, NOT session-scoped — this is what makes the cross-agent handoff work:
    // a query from Cursor sees the turns Claude wrote, because they share project_id.
    const rows = this.db
      .prepare(
        `SELECT sig, parent_sig, prompt_text, session_id, source, project_id, ts
         FROM prompt_sig
         WHERE project_id = ?
         ORDER BY ts DESC
         LIMIT ?`,
      )
      .all(projectId, limit) as PromptSigRow[]
    return rows.map(rowToPromptSig)
  }

  getChangesForSig(sig: string): Change[] {
    const rows = this.db
      .prepare(
        `SELECT sig, file, symbol, change_type FROM change WHERE sig = ? ORDER BY id`,
      )
      .all(sig) as ChangeRow[]
    return rows.map(rowToChange)
  }

  getContextChunkBySig(sig: string): ContextChunk | undefined {
    const row = this.db
      .prepare(
        `SELECT id, sig, text, project_id, ts FROM context_chunk WHERE id = ?`,
      )
      .get(contextChunkIdForSig(sig)) as ContextChunkRow | undefined
    return row ? rowToContextChunk(row) : undefined
  }

  getParentChain(sig: string, maxDepth: number): PromptSig[] {
    const chain: PromptSig[] = []
    let current: string | null = sig
    let depth = 0
    while (current && depth < maxDepth) {
      const row = this.db
        .prepare(
          `SELECT sig, parent_sig, prompt_text, session_id, source, project_id, ts
           FROM prompt_sig WHERE sig = ?`,
        )
        .get(current) as PromptSigRow | undefined
      if (!row) break
      const ps = rowToPromptSig(row)
      chain.push(ps)
      current = ps.parentSig
      depth++
    }
    return chain
  }

  private loadContextChunksById(orderedIds: string[]): ContextChunk[] {
    if (orderedIds.length === 0) return []
    const placeholders = orderedIds.map(() => '?').join(', ')
    const rows = this.db
      .prepare(
        `SELECT id, sig, text, project_id, ts
         FROM context_chunk
         WHERE id IN (${placeholders})`,
      )
      .all(...orderedIds) as ContextChunkRow[]
    const byId = new Map(rows.map(row => [row.id, rowToContextChunk(row)]))
    return orderedIds
      .map(id => byId.get(id))
      .filter((chunk): chunk is ContextChunk => chunk !== undefined)
  }

  private queryVectorScoped(projectId: string, embedding: number[], limit: number): string[] {
    if (embedding.length === 0 || limit <= 0) return []
    const rows = this.db
      .prepare(
        `SELECT v.chunk_id
         FROM chunk_vec v
         INNER JOIN context_chunk c ON c.id = v.chunk_id
         WHERE c.project_id = ?
           AND v.embedding MATCH ?
           AND k = ?
         ORDER BY distance`,
      )
      .all(projectId, embeddingToBuffer(embedding), limit) as { chunk_id: string }[]
    return rows.map(row => row.chunk_id)
  }

  private queryFtsScoped(projectId: string, keywords: string, limit: number): string[] {
    const query = ftsQuery(keywords)
    if (!query || limit <= 0) return []
    const rows = this.db
      .prepare(
        `SELECT c.id
         FROM chunk_fts f
         INNER JOIN context_chunk c ON c.rowid = f.rowid
         WHERE c.project_id = ?
           AND chunk_fts MATCH ?
         ORDER BY bm25(chunk_fts)
         LIMIT ?`,
      )
      .all(projectId, query, limit) as { id: string }[]
    return rows.map(row => row.id)
  }

  queryChangesForSymbol(symbol: string): Change[] {
    // Time-order via prompt_sig.ts (the change row itself has no ts). rowid would
    // diverge from real time once orphan recovery commits sessions out of order.
    const rows = this.db
      .prepare(
        `SELECT c.sig, c.file, c.symbol, c.change_type
         FROM change c
         JOIN prompt_sig p ON p.sig = c.sig
         WHERE c.symbol = ?
         ORDER BY p.ts, c.id`,
      )
      .all(symbol) as ChangeRow[]
    return rows.map(rowToChange)
  }

  /**
   * Blast radius = REVERSE traversal: "if `symbol` changes, what is AFFECTED?" Walk the edges that
   * POINT AT the symbol (its dependents/callers), transitively, depth-bounded. Edges are stored
   * from=caller → to=callee, so dependents are the `from_symbol`s of matching edges. Matched by
   * symbol NAME (cross-file `to_file` may be '' when we couldn't fully resolve it — graphify
   * federation fills that in). Direction per graphify `affected.py` (in-edges, not out-edges).
   */
  queryBlastRadius(symbol: string, file: string, depth: number = 3): SymbolDep[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE blast(from_symbol, from_file, to_symbol, to_file, depth) AS (
           SELECT from_symbol, from_file, to_symbol, to_file, 1
           FROM symbol_dep
           WHERE to_symbol = ? AND (to_file = ? OR to_file = '')
           UNION
           SELECT sd.from_symbol, sd.from_file, sd.to_symbol, sd.to_file, b.depth + 1
           FROM symbol_dep sd
           INNER JOIN blast b
             ON sd.to_symbol = b.from_symbol
           WHERE b.depth < ?
         )
         SELECT DISTINCT from_symbol, from_file, to_symbol, to_file
         FROM blast
         LIMIT ?`,
      )
      .all(symbol, file, depth, MAX_BLAST_ROWS) as SymbolDepRow[]
    return rows.map(rowToSymbolDep)
  }

  private queryVector(embedding: number[], limit: number): string[] {
    if (embedding.length === 0 || limit <= 0) return []

    const rows = this.db
      .prepare(
        `SELECT chunk_id
         FROM chunk_vec
         WHERE embedding MATCH ?
           AND k = ?
         ORDER BY distance`,
      )
      .all(embeddingToBuffer(embedding), limit) as { chunk_id: string }[]

    return rows.map(row => row.chunk_id)
  }

  private queryFts(keywords: string, limit: number): string[] {
    const query = ftsQuery(keywords)
    if (!query || limit <= 0) return []

    const rows = this.db
      .prepare(
        `SELECT c.id
         FROM chunk_fts f
         INNER JOIN context_chunk c ON c.rowid = f.rowid
         WHERE chunk_fts MATCH ?
         ORDER BY bm25(chunk_fts)
         LIMIT ?`,
      )
      .all(query, limit) as { id: string }[]

    return rows.map(row => row.id)
  }
}

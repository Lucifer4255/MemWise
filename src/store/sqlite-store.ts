import type Database from 'better-sqlite3'
import type {
  Change,
  ContextChunk,
  MemoryStore,
  PromptSig,
  Source,
  SymbolDep,
} from './memory-store.js'

const RRF_K = 60
// Hard cap on blast-radius rows so a densely-connected (diamond) dep graph can't
// expand without bound before the final DISTINCT (spec §11: DISTINCT + LIMIT).
const MAX_BLAST_ROWS = 500

type PromptSigRow = {
  sig: string
  parent_sig: string | null
  prompt_text: string
  intent_text: string | null
  segment_idx: number
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

function embeddingToBuffer(embedding: number[]): Buffer {
  const floats = new Float32Array(embedding)
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength)
}

function rowToPromptSig(row: PromptSigRow): PromptSig {
  return {
    sig: row.sig,
    parentSig: row.parent_sig,
    promptText: row.prompt_text,
    intentText: row.intent_text,
    segmentIdx: row.segment_idx,
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

  insertPromptSig(sig: PromptSig): void {
    this.db
      .prepare(
        `INSERT INTO prompt_sig (
          sig, parent_sig, prompt_text, intent_text, segment_idx,
          session_id, source, project_id, ts
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sig.sig,
        sig.parentSig,
        sig.promptText,
        sig.intentText,
        sig.segmentIdx,
        sig.sessionId,
        sig.source,
        sig.projectId,
        sig.ts,
      )
  }

  getPromptSig(sig: string): PromptSig | undefined {
    const row = this.db
      .prepare(
        `SELECT sig, parent_sig, prompt_text, intent_text, segment_idx,
                session_id, source, project_id, ts
         FROM prompt_sig WHERE sig = ?`,
      )
      .get(sig) as PromptSigRow | undefined
    return row ? rowToPromptSig(row) : undefined
  }

  insertChange(change: Change): void {
    this.db
      .prepare(
        `INSERT INTO change (sig, file, symbol, change_type)
         VALUES (?, ?, ?, ?)`,
      )
      .run(change.sig, change.file, change.symbol, change.changeType)
  }

  insertSymbolDep(dep: SymbolDep): void {
    this.db
      .prepare(
        `INSERT INTO symbol_dep (from_symbol, from_file, to_symbol, to_file)
         VALUES (?, ?, ?, ?)`,
      )
      .run(dep.fromSymbol, dep.fromFile, dep.toSymbol, dep.toFile)
  }

  insertContextChunk(chunk: ContextChunk, embedding: number[]): void {
    const insert = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO context_chunk (id, sig, text, project_id, ts)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(chunk.id, chunk.sig, chunk.text, chunk.projectId, chunk.ts)

      this.db
        .prepare(`INSERT INTO chunk_vec (chunk_id, embedding) VALUES (?, ?)`)
        .run(chunk.id, embeddingToBuffer(embedding))
    })

    insert()
  }

  queryHybrid(embedding: number[], keywords: string, limit: number): ContextChunk[] {
    const vecRanked = this.queryVector(embedding, limit)
    const ftsRanked = this.queryFts(keywords, limit)

    const scores = new Map<string, number>()
    for (let i = 0; i < vecRanked.length; i++) {
      const id = vecRanked[i]!
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + i + 1))
    }
    for (let i = 0; i < ftsRanked.length; i++) {
      const id = ftsRanked[i]!
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + i + 1))
    }

    const orderedIds = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => id)

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

  queryBlastRadius(symbol: string, file: string, depth: number = 3): SymbolDep[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE blast(from_symbol, from_file, to_symbol, to_file, depth) AS (
           SELECT from_symbol, from_file, to_symbol, to_file, 1
           FROM symbol_dep
           WHERE from_symbol = ? AND from_file = ?
           UNION ALL
           SELECT sd.from_symbol, sd.from_file, sd.to_symbol, sd.to_file, b.depth + 1
           FROM symbol_dep sd
           INNER JOIN blast b
             ON sd.from_symbol = b.to_symbol AND sd.from_file = b.to_file
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

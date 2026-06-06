import type Database from 'better-sqlite3'
import { embeddingToBuffer } from '../embed/vector.js'
import { fuseRankedLists } from '../core/rrf.js'
import type {
  CaptureCursor,
  Change,
  ContextChunk,
  MemoryStore,
  ProjectSummary,
  PromptSig,
  RecentMessage,
  SessionSummary,
  Source,
  SymbolDep,
  TelemetryEvent,
  TelemetryKind,
  TurnEdge,
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

function safeJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s) as unknown
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function ftsQuery(keywords: string): string {
  const trimmed = keywords.trim()
  if (!trimmed) return ''
  // Quote tokens that contain FTS special characters; otherwise pass through.
  // Join with OR (not the FTS5 default implicit AND): in hybrid retrieval we want
  // recall — a chunk matching ANY keyword is a candidate, and RRF + BM25 rank it.
  // Requiring every term (AND) silently drops good partial matches.
  // FTS5 boolean keywords are reserved even as plain barewords — a query containing the
  // word "AND"/"OR"/"NOT"/"NEAR" must be quoted or it's parsed as an operator.
  const FTS_KEYWORDS = new Set(['AND', 'OR', 'NOT', 'NEAR'])
  const tokens = trimmed.split(/\s+/).filter(Boolean)
  return tokens
    .map(token => {
      // Quote any token that isn't a plain bareword, or that collides with an FTS5 keyword.
      // FTS5 reserves a wide set of chars (" * ( ) : ^ [ ] { } - + . / @ , etc.) — quoting as a
      // phrase is the safe path and avoids "fts5: syntax error" on real prompts that contain
      // @paths, [brackets], hyphens, or the literal words and/or/not.
      if (/[^\w]/.test(token) || FTS_KEYWORDS.has(token.toUpperCase())) {
        const cleaned = token.replace(/"/g, '""')
        return `"${cleaned}"`
      }
      return token
    })
    .filter(t => t !== '""')
    .join(' OR ')
}

export class SqliteStore implements MemoryStore {
  constructor(private readonly db: Database.Database) {}

  /** Run `fn` inside a single transaction (nested calls use SAVEPOINTs via better-sqlite3). */
  runTransaction(fn: () => void): void {
    this.db.transaction(fn)()
  }

  insertSessionSummary(row: Omit<SessionSummary, 'id'>): void {
    this.db
      .prepare(
        `INSERT INTO session_summary (project_id, source, sig_range, summary, ts)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(row.projectId, row.source, row.sigRange, row.summary, row.ts)
  }

  queryLatestSessionSummary(projectId: string): SessionSummary | undefined {
    // Prefer nightshift (cross-window synthesis) over postcompact (raw per-window snapshot).
    const row = this.db
      .prepare(
        `SELECT id, project_id, source, sig_range, summary, ts FROM session_summary
         WHERE project_id = ?
         ORDER BY CASE source WHEN 'nightshift' THEN 0 ELSE 1 END, ts DESC LIMIT 1`,
      )
      .get(projectId) as { id: number; project_id: string; source: string; sig_range: string; summary: string; ts: number } | undefined
    if (!row) return undefined
    return {
      id: row.id,
      projectId: row.project_id,
      source: row.source as SessionSummary['source'],
      sigRange: row.sig_range,
      summary: row.summary,
      ts: row.ts,
    }
  }

  getCaptureCursor(sessionId: string): CaptureCursor | undefined {
    const row = this.db
      .prepare(`SELECT session_id, last_uuid, ts FROM capture_cursor WHERE session_id = ?`)
      .get(sessionId) as { session_id: string; last_uuid: string; ts: number } | undefined
    if (!row) return undefined
    return { sessionId: row.session_id, lastUuid: row.last_uuid, ts: row.ts }
  }

  setCaptureCursor(cursor: CaptureCursor): void {
    this.db
      .prepare(
        `INSERT INTO capture_cursor (session_id, last_uuid, ts) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET last_uuid = excluded.last_uuid, ts = excluded.ts`,
      )
      .run(cursor.sessionId, cursor.lastUuid, cursor.ts)
  }

  insertTelemetry(kind: TelemetryKind, payload: Record<string, unknown>): void {
    this.db
      .prepare(`INSERT INTO telemetry (ts, kind, payload) VALUES (?, ?, ?)`)
      .run(Date.now(), kind, JSON.stringify(payload))
  }

  queryRecentTelemetry(afterId: number, limit: number): TelemetryEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, ts, kind, payload FROM telemetry WHERE id > ? ORDER BY id ASC LIMIT ?`,
      )
      .all(afterId, limit) as { id: number; ts: number; kind: string; payload: string }[]
    return rows.map(r => ({
      id: r.id,
      ts: r.ts,
      kind: r.kind as TelemetryKind,
      payload: safeJson(r.payload),
    }))
  }

  queryRecentMessages(limit: number): RecentMessage[] {
    const rows = this.db
      .prepare(
        `SELECT p.sig AS sig, c.project_id AS project_id, p.prompt_text AS prompt_text,
                c.text AS text, c.enriched AS enriched, c.ts AS ts
         FROM context_chunk c
         JOIN prompt_sig p ON p.sig = c.sig
         ORDER BY c.ts DESC
         LIMIT ?`,
      )
      .all(limit) as {
      sig: string
      project_id: string
      prompt_text: string
      text: string
      enriched: number
      ts: number
    }[]
    return rows.map(r => ({
      sig: r.sig,
      projectId: r.project_id,
      promptText: r.prompt_text,
      text: r.text,
      enriched: r.enriched === 1,
      ts: r.ts,
    }))
  }

  queryRecentMessagesScoped(projectId: string, limit: number): RecentMessage[] {
    const rows = this.db
      .prepare(
        `SELECT p.sig AS sig, c.project_id AS project_id, p.prompt_text AS prompt_text,
                c.text AS text, c.enriched AS enriched, c.ts AS ts
         FROM context_chunk c
         JOIN prompt_sig p ON p.sig = c.sig
         WHERE p.project_id = ?
         ORDER BY c.ts DESC
         LIMIT ?`,
      )
      .all(projectId, limit) as {
      sig: string
      project_id: string
      prompt_text: string
      text: string
      enriched: number
      ts: number
    }[]
    return rows.map(r => ({
      sig: r.sig,
      projectId: r.project_id,
      promptText: r.prompt_text,
      text: r.text,
      enriched: r.enriched === 1,
      ts: r.ts,
    }))
  }

  queryProjects(): ProjectSummary[] {
    const rows = this.db
      .prepare(
        `SELECT p.project_id,
                COUNT(DISTINCT p.sig) AS messages,
                COUNT(DISTINCT s.id)  AS summaries,
                MAX(p.ts)             AS last_ts
         FROM prompt_sig p
         LEFT JOIN session_summary s ON s.project_id = p.project_id
         GROUP BY p.project_id
         ORDER BY last_ts DESC`,
      )
      .all() as { project_id: string; messages: number; summaries: number; last_ts: number }[]
    return rows.map(r => ({
      projectId: r.project_id,
      messages: r.messages,
      summaries: r.summaries,
      lastTs: r.last_ts,
    }))
  }

  countChunksSince(projectId: string, sinceTs: number): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM context_chunk WHERE project_id = ? AND ts > ?`)
        .get(projectId, sinceTs) as { n: number }
    ).n
  }

  queryRecentSessionSummaries(projectId: string, limit: number): SessionSummary[] {
    if (limit <= 0) return []
    const rows = this.db
      .prepare(
        `SELECT id, project_id, source, sig_range, summary, ts FROM session_summary
         WHERE project_id = ? ORDER BY ts DESC LIMIT ?`,
      )
      .all(projectId, limit) as {
      id: number
      project_id: string
      source: string
      sig_range: string
      summary: string
      ts: number
    }[]
    return rows.map(r => ({
      id: r.id,
      projectId: r.project_id,
      source: r.source as SessionSummary['source'],
      sigRange: r.sig_range,
      summary: r.summary,
      ts: r.ts,
    }))
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
          `INSERT OR IGNORE INTO context_chunk (id, sig, text, project_id, ts, enriched, embedded)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          chunk.id,
          chunk.sig,
          chunk.text,
          chunk.projectId,
          chunk.ts,
          chunk.enriched ? 1 : 0,
          embedding.length > 0 ? 1 : 0,
        )

      if (res.changes === 0) return
      if (embedding.length === 0) return

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

  insertTurnEdgeOrIgnore(edge: TurnEdge): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO turn_edge (from_sig, to_sig, edge_type, label, ts)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(edge.fromSig, edge.toSig, edge.edgeType, edge.label, edge.ts)
  }

  getPriorTurnForFile(file: string, projectId: string, excludeSig: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT p.sig FROM change c
         JOIN prompt_sig p ON p.sig = c.sig
         WHERE c.file = ? AND p.project_id = ? AND p.sig != ?
         ORDER BY p.ts DESC LIMIT 1`,
      )
      .get(file, projectId, excludeSig) as { sig: string } | undefined
    return row?.sig
  }

  getPriorTurnForSymbol(symbol: string, projectId: string, excludeSig: string): string | undefined {
    if (!symbol || symbol === '<file>') return undefined
    const row = this.db
      .prepare(
        `SELECT p.sig FROM change c
         JOIN prompt_sig p ON p.sig = c.sig
         WHERE c.symbol = ? AND p.project_id = ? AND p.sig != ?
         ORDER BY p.ts DESC LIMIT 1`,
      )
      .get(symbol, projectId, excludeSig) as { sig: string } | undefined
    return row?.sig
  }

  getEdgeNeighbors(sig: string, limit: number): TurnEdge[] {
    if (limit <= 0) return []
    const rows = this.db
      .prepare(
        `SELECT from_sig, to_sig, edge_type, label, ts FROM turn_edge
         WHERE from_sig = ? OR to_sig = ?
         ORDER BY ts DESC LIMIT ?`,
      )
      .all(sig, sig, limit) as {
      from_sig: string
      to_sig: string
      edge_type: string
      label: string
      ts: number
    }[]
    return rows.map(r => ({
      fromSig: r.from_sig,
      toSig: r.to_sig,
      edgeType: r.edge_type as TurnEdge['edgeType'],
      label: r.label,
      ts: r.ts,
    }))
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

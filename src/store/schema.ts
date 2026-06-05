import type Database from 'better-sqlite3'
import { EMBED_DIM } from '../config.js'

/**
 * Bump when the schema changes. Stamped into the DB via `PRAGMA user_version`.
 * A real migrator (future) reads user_version and applies forward diffs — for now
 * this just records "which schema this DB was created with" so we're not flying
 * blind once a shipped DB needs to gain a column. `CREATE … IF NOT EXISTS` never
 * alters existing tables, so additive changes still need an explicit migration.
 */
export const SCHEMA_VERSION = 6

export function schemaSql(embedDim: number = EMBED_DIM): string {
  return `
PRAGMA foreign_keys = ON;
PRAGMA user_version = ${SCHEMA_VERSION};

-- The "spine": one row per user message (identity). Pooled context → context_chunk,
-- code edits → change; both join back on sig. (v2: dropped per-segment intent_text/segment_idx.)
CREATE TABLE IF NOT EXISTS prompt_sig (
  sig TEXT PRIMARY KEY,
  parent_sig TEXT,
  prompt_text TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source TEXT NOT NULL,
  project_id TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS change (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sig TEXT NOT NULL,
  file TEXT NOT NULL,
  symbol TEXT NOT NULL,
  change_type TEXT NOT NULL,
  FOREIGN KEY(sig) REFERENCES prompt_sig(sig)
);

CREATE INDEX IF NOT EXISTS idx_change_symbol ON change(symbol);
CREATE INDEX IF NOT EXISTS idx_change_sig ON change(sig);
-- parentSig resolution (Layer 2 close()) filters change by file → index it
CREATE INDEX IF NOT EXISTS idx_change_file ON change(file);
-- A message's edit set is identity: re-flushing the same sig must not duplicate rows.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_change
  ON change(sig, file, symbol, change_type);

CREATE TABLE IF NOT EXISTS symbol_dep (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_symbol TEXT NOT NULL,
  from_file TEXT NOT NULL,
  to_symbol TEXT NOT NULL,
  to_file TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_symbol_dep_from
  ON symbol_dep(from_symbol, from_file);
CREATE INDEX IF NOT EXISTS idx_symbol_dep_to
  ON symbol_dep(to_symbol, to_file);
-- The same dependency edge can be rediscovered across messages — store it once.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_symbol_dep
  ON symbol_dep(from_symbol, from_file, to_symbol, to_file);

CREATE TABLE IF NOT EXISTS context_chunk (
  id TEXT PRIMARY KEY,
  sig TEXT NOT NULL,
  text TEXT NOT NULL,
  project_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  -- v5: enriched=1 once the chat model rewrote the text; embedded=1 once a vector exists.
  -- Normally both land together in the single turn-end write; the flags let "memwise catch-up"
  -- find a row whose write was interrupted before its vector was inserted.
  enriched INTEGER NOT NULL DEFAULT 0,
  embedded INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(sig) REFERENCES prompt_sig(sig)
);

CREATE INDEX IF NOT EXISTS idx_context_chunk_sig ON context_chunk(sig);
CREATE INDEX IF NOT EXISTS idx_context_chunk_project ON context_chunk(project_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec USING vec0(
  chunk_id TEXT,
  embedding FLOAT[${embedDim}]
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
  text,
  content='context_chunk',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS context_chunk_ai AFTER INSERT ON context_chunk BEGIN
  INSERT INTO chunk_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER IF NOT EXISTS context_chunk_ad AFTER DELETE ON context_chunk BEGIN
  INSERT INTO chunk_fts(chunk_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  -- vec0 takes no FK, so evict its row here or consolidation (§13/§14) leaks vectors
  DELETE FROM chunk_vec WHERE chunk_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS context_chunk_au AFTER UPDATE ON context_chunk BEGIN
  INSERT INTO chunk_fts(chunk_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO chunk_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TABLE IF NOT EXISTS session_summary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'nightshift',
  sig_range TEXT NOT NULL,
  summary TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_summary_project ON session_summary(project_id, ts DESC);

CREATE TABLE IF NOT EXISTS semantic_fact (
  id TEXT PRIMARY KEY,
  fact TEXT NOT NULL,
  confidence REAL NOT NULL,
  support INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS procedural (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,
  sequence TEXT NOT NULL,
  freq INTEGER NOT NULL DEFAULT 0
);

-- v5: per-session transcript read cursor. Capture reads the transcript from here forward, so
-- a cancelled turn (no Stop) is picked up at the next trigger and nothing is processed twice.
CREATE TABLE IF NOT EXISTS capture_cursor (
  session_id TEXT PRIMARY KEY,
  last_uuid TEXT NOT NULL,
  ts INTEGER NOT NULL
);

-- v6: turn-level graph edges. Each edge links two turns that share a file or symbol, or records
-- the forward direction of the spine (parent→child). Edge model: for each file/symbol touched by a
-- new turn, we store ONE edge to the most recent prior turn that also touched it — a per-file /
-- per-symbol linked list. This keeps edge count O(n) while enabling full history traversal.
--   edge_type: 'file'    label = file path   (prev turn that touched this file)
--              'symbol'  label = symbol name  (prev turn that touched this symbol)
--              'forward' label = ''           (parent → child spine direction)
CREATE TABLE IF NOT EXISTS turn_edge (
  from_sig   TEXT NOT NULL,
  to_sig     TEXT NOT NULL,
  edge_type  TEXT NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  ts         INTEGER NOT NULL,
  PRIMARY KEY (from_sig, to_sig, edge_type, label)
);
-- label-based lookup: "all turns that touched file X" — walks the chain
CREATE INDEX IF NOT EXISTS idx_turn_edge_label ON turn_edge(edge_type, label, ts DESC);
-- reverse lookup: "what turns point TO this sig?" — enables forward traversal
CREATE INDEX IF NOT EXISTS idx_turn_edge_to ON turn_edge(to_sig);

-- v5: append-only observability events (kind: 'message' | 'enrich' | 'embed' | 'job2').
-- Read by the on-demand dashboard; never on the hot path.
CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_telemetry_kind_ts ON telemetry(kind, ts DESC);
`
}

/** Tables added after first ship — applied idempotently by re-running `schemaSql` (all use
 *  `CREATE TABLE/INDEX IF NOT EXISTS`). Only explicit column additions need separate migration. */
function migrateAdditiveColumns(db: Database.Database): void {
  const cols = (db.prepare(`PRAGMA table_info(context_chunk)`).all() as { name: string }[]).map(
    c => c.name,
  )
  if (!cols.includes('enriched')) {
    db.exec(`ALTER TABLE context_chunk ADD COLUMN enriched INTEGER NOT NULL DEFAULT 0`)
  }
  if (!cols.includes('embedded')) {
    db.exec(`ALTER TABLE context_chunk ADD COLUMN embedded INTEGER NOT NULL DEFAULT 0`)
  }
}

export function applySchema(db: Database.Database, embedDim: number = EMBED_DIM): void {
  db.exec(schemaSql(embedDim))
  migrateAdditiveColumns(db)
}

import type Database from 'better-sqlite3'
import { EMBED_DIM } from '../config.js'

/**
 * Bump when the schema changes. Stamped into the DB via `PRAGMA user_version`.
 * A real migrator (future) reads user_version and applies forward diffs — for now
 * this just records "which schema this DB was created with" so we're not flying
 * blind once a shipped DB needs to gain a column. `CREATE … IF NOT EXISTS` never
 * alters existing tables, so additive changes still need an explicit migration.
 */
export const SCHEMA_VERSION = 2

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

CREATE TABLE IF NOT EXISTS context_chunk (
  id TEXT PRIMARY KEY,
  sig TEXT NOT NULL,
  text TEXT NOT NULL,
  project_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
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
  sig_range TEXT NOT NULL,
  summary TEXT NOT NULL,
  ts INTEGER NOT NULL
);

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
`
}

export function applySchema(db: Database.Database, embedDim: number = EMBED_DIM): void {
  db.exec(schemaSql(embedDim))
}

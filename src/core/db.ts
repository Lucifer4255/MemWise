import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { EMBED_DIM, MEMWISE_DB_PATH } from './config.js'
import { applySchema } from '../store/schema.js'
import { SqliteStore } from '../store/sqlite-store.js'

export function openDatabase(
  path: string = ':memory:',
  embedDim: number = EMBED_DIM,
): { db: Database.Database; store: SqliteStore } {
  const db = new Database(path)
  sqliteVec.load(db)
  applySchema(db, embedDim)
  return { db, store: new SqliteStore(db) }
}

/** Open the configured on-disk memwise DB (creates parent dirs if needed). */
export function openDefaultStore(embedDim: number = EMBED_DIM): {
  db: Database.Database
  store: SqliteStore
} {
  mkdirSync(dirname(MEMWISE_DB_PATH), { recursive: true })
  return openDatabase(MEMWISE_DB_PATH, embedDim)
}

let cachedDefault: { db: Database.Database; store: SqliteStore } | null = null

/** Process-wide singleton over the on-disk DB. Use this on hot paths (retrieval, MCP server)
 *  so repeated calls reuse one connection instead of leaking a file handle per call. */
export function getDefaultStore(embedDim: number = EMBED_DIM): {
  db: Database.Database
  store: SqliteStore
} {
  if (!cachedDefault) cachedDefault = openDefaultStore(embedDim)
  return cachedDefault
}

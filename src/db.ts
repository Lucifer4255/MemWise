import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { EMBED_DIM } from './config.js'
import { applySchema } from './store/schema.js'
import { SqliteStore } from './store/sqlite-store.js'

export function openDatabase(
  path: string = ':memory:',
  embedDim: number = EMBED_DIM,
): { db: Database.Database; store: SqliteStore } {
  const db = new Database(path)
  sqliteVec.load(db)
  applySchema(db, embedDim)
  return { db, store: new SqliteStore(db) }
}

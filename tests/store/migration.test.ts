import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { applySchema } from '../../src/store/schema.js'

type TestResult = { name: string; ok: boolean; detail: string }
const pass = (name: string, detail = ''): TestResult => ({ name, ok: true, detail })
const fail = (name: string, detail: string): TestResult => ({ name, ok: false, detail })

/**
 * Regression: applySchema must upgrade a pre-v7 DB whose semantic_fact/procedural tables predate
 * the project_id/created_ts/last_seen columns — WITHOUT failing on the v7 indexes and WITHOUT
 * dropping legacy rows. (Caught in the field: "no such column: project_id" when the index was
 * created before the ALTER.)
 */
function main(): void {
  const results: TestResult[] = []
  const db = new Database(':memory:')
  sqliteVec.load(db)

  // Simulate a v6 DB: old tier tables without the v7 columns, with legacy rows.
  db.exec(`CREATE TABLE semantic_fact (id TEXT PRIMARY KEY, fact TEXT NOT NULL, confidence REAL NOT NULL, support INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL);`)
  db.exec(`CREATE TABLE procedural (id TEXT PRIMARY KEY, pattern TEXT NOT NULL, sequence TEXT NOT NULL, freq INTEGER NOT NULL DEFAULT 0);`)
  db.prepare(`INSERT INTO semantic_fact (id,fact,confidence,support,last_seen) VALUES ('old','legacy fact',0.5,2,123)`).run()
  db.prepare(`INSERT INTO procedural (id,pattern,sequence,freq) VALUES ('op','legacy pattern','[]',1)`).run()

  let threw = ''
  try {
    applySchema(db) // must ALTER-add columns then create the v7 indexes, no error
  } catch (e) {
    threw = String(e)
  }

  const semCols = (db.prepare(`PRAGMA table_info(semantic_fact)`).all() as { name: string }[]).map(c => c.name)
  const procCols = (db.prepare(`PRAGMA table_info(procedural)`).all() as { name: string }[]).map(c => c.name)
  const semRow = db.prepare(`SELECT fact, project_id FROM semantic_fact WHERE id='old'`).get() as { fact: string; project_id: string } | undefined
  const procRow = db.prepare(`SELECT pattern, last_seen FROM procedural WHERE id='op'`).get() as { pattern: string; last_seen: number } | undefined

  results.push(threw ? fail('applySchema on v6 DB', threw) : pass('applySchema on v6 DB', 'no error'))
  results.push(
    semCols.includes('project_id') && semCols.includes('created_ts')
      ? pass('semantic_fact columns added', semCols.join(','))
      : fail('semantic_fact columns added', semCols.join(',')),
  )
  results.push(
    procCols.includes('project_id') && procCols.includes('created_ts') && procCols.includes('last_seen')
      ? pass('procedural columns added', procCols.join(','))
      : fail('procedural columns added', procCols.join(',')),
  )
  results.push(
    semRow?.fact === 'legacy fact' && semRow.project_id === '' && procRow?.pattern === 'legacy pattern'
      ? pass('legacy rows preserved', `defaults backfilled`)
      : fail('legacy rows preserved', JSON.stringify({ semRow, procRow })),
  )

  // Idempotent: applying again must not error.
  let threw2 = ''
  try {
    applySchema(db)
  } catch (e) {
    threw2 = String(e)
  }
  results.push(threw2 ? fail('applySchema idempotent', threw2) : pass('applySchema idempotent', 're-apply OK'))

  db.close()

  console.log('\n── memwise schema migration tests ──\n')
  let passed = 0
  for (const r of results) {
    const icon = r.ok ? '✓' : '✗'
    const label = r.ok ? '\x1b[32m' : '\x1b[31m'
    console.log(`  ${label}${icon}\x1b[0m  ${r.name.padEnd(30)} ${r.detail}`)
    if (r.ok) passed++
  }
  console.log(`\n  ${passed}/${results.length} passed\n`)
  process.exit(passed === results.length ? 0 : 1)
}

main()

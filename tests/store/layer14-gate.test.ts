// Layer 14 #9 — gate items not covered by the per-feature tests:
//   (1) SPINE INTEGRITY: no Layer-14 write ever UPDATEs/DELETEs prompt_sig or change rows.
//   (2) graph-proximity rank (3rd RRF signal) reorders toward graph-central candidates.
// Run: npx tsx tests/store/layer14-gate.test.ts
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { applySchema } from '../../src/store/schema.js'
import { SqliteStore } from '../../src/store/sqlite-store.js'
import { graphProximityRank } from '../../src/retrieval/hybrid-search.js'
import { EMBED_DIM } from '../../src/core/config.js'

const db = new Database(':memory:'); sqliteVec.load(db); applySchema(db)
const store = new SqliteStore(db)
const PROJ = 'p1'
let pass = 0, fail = 0
const check = (l: string, c: boolean, d = '') => { console.log(`  ${c ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'}  ${l}${d ? '   ' + d : ''}`); c ? pass++ : fail++ }
const vec = (n: number) => Array.from({ length: EMBED_DIM }, (_, i) => Math.sin(n + i))
const snap = (t: string) => JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())

console.log('\n── spine integrity: Layer 14 writes never mutate the spine ──')
let ts = 1000
for (const sig of ['t1', 't2', 't3']) {
  ts++
  store.insertPromptSig({ sig, parentSig: sig === 't1' ? null : `t${+sig[1]! - 1}`, promptText: `p ${sig}`, sessionId: 's', source: 'claude-code', projectId: PROJ, ts })
  store.insertChange({ sig, file: 'a.ts', symbol: 'foo', changeType: 'modified' })
  store.insertContextChunk({ id: `${sig}:ctx`, sig, text: `work ${sig}`, projectId: PROJ, ts, enriched: true }, vec(+sig[1]!))
}
const spineBefore = snap('prompt_sig')
const changeBefore = snap('change')

// every Layer 14 write path
store.upsertSessionNode({ nodeSig: 'sess:x', projectId: PROJ, source: 'nightshift', sigRange: 't1..t3', summary: 'recap', ts: 2000 }, vec(9))
for (const m of ['t1', 't2', 't3']) store.insertTurnEdgeOrIgnore({ fromSig: 'sess:x', toSig: m, edgeType: 'summarizes', label: '', ts: 2000 })
store.upsertSessionNode({ nodeSig: 'sess:x', projectId: PROJ, source: 'nightshift', sigRange: 't1..t3', summary: 'recap v2', ts: 2100 }, vec(9)) // re-summarize
const now = Date.now()
store.upsertDecision({ id: 'd1', projectId: PROJ, statement: 'choice A', rationale: 'r', confidence: 0.8, createdTs: now, lastSeen: now, supersededBy: '' }, vec(7))
store.insertRealizedByEdges('d1', ['t1', 't2'], now)
store.upsertDecision({ id: 'd2', projectId: PROJ, statement: 'choice B', rationale: 'r', confidence: 0.9, createdTs: now, lastSeen: now, supersededBy: '' }, vec(8))
store.markDecisionSuperseded('d1', 'd2', now)

check('prompt_sig rows byte-identical after Layer 14 writes', snap('prompt_sig') === spineBefore)
check('change rows byte-identical after Layer 14 writes', snap('change') === changeBefore)
// the spine is still walkable
check('parent chain intact', store.getParentChain('t3', 8).map(p => p.sig).join(',') === 't3,t2,t1')

console.log('\n── graph-proximity rank (3rd RRF signal) ──')
// a–b connected via a file edge; c isolated. Same content order in → graph boosts a,b over c.
store.insertTurnEdgeOrIgnore({ fromSig: 't1', toSig: 't2', edgeType: 'file', label: 'a.ts', ts: 1000 })
// input content order puts the isolated candidate FIRST; proximity must demote it.
const reordered = graphProximityRank(store, ['t3', 't1', 't2'])
check('connected candidates rise above isolated', reordered.indexOf('t1') < reordered.indexOf('t3') && reordered.indexOf('t2') < reordered.indexOf('t3'), reordered.join(','))
// no-op safety: single candidate or no edges returns input order
check('single candidate unchanged', graphProximityRank(store, ['t3']).join(',') === 't3')

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass}/${pass + fail} passed\x1b[0m\n`)
process.exit(fail === 0 ? 0 : 1)

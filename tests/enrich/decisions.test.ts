// Layer 14 #5 — night-shift extracts Decision nodes from the Why chain (gated, stubbed model+embed).
// Run: MEMWISE_DECISION_TIER=on npx tsx tests/enrich/decisions.test.ts
import { openDatabase } from '../../src/core/db.js'
import { maybeExtractDecisions } from '../../src/enrich/decisions.js'
import { DECISION_TIER_ENABLED } from '../../src/core/config.js'
import { EMBED_DIM } from '../../src/core/config.js'
import type { SqliteStore } from '../../src/store/sqlite-store.js'
import type { GenerateClient } from '../../src/embed/generate-client.js'

const { store } = openDatabase(':memory:')
const PROJ = 'p1'
let pass = 0, fail = 0
const check = (l: string, c: boolean, d = '') => { console.log(`  ${c ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'}  ${l}${d ? '   ' + d : ''}`); c ? pass++ : fail++ }
const embedFn = (t: string) => Promise.resolve(Array.from({ length: EMBED_DIM }, (_, i) => Math.sin(t.length + i)))

if (!DECISION_TIER_ENABLED) {
  console.error('\n  run with MEMWISE_DECISION_TIER=on\n')
  process.exit(2)
}

// model that returns a fixed decision the first run, then a superseding one the second run
function clientReturning(json: string): GenerateClient {
  return { isAvailable: () => Promise.resolve(true), generate: () => Promise.resolve(json) } as unknown as GenerateClient
}

async function main() {
  // seed change-linked turns (prompt_sig + change + chunk) so queryRecentChangeLinkedChunks finds them
  let ts = 1000
  for (const sig of ['t1', 't2']) {
    ts++
    store.insertPromptSig({ sig, parentSig: null, promptText: 'p:' + sig, sessionId: 's', source: 'claude-code', projectId: PROJ, ts })
    store.insertChange({ sig, file: 'cache.ts', symbol: 'hotWindow', changeType: 'modified' })
    store.insertContextChunk({ id: `${sig}:ctx`, sig, text: `added redis hot-window in ${sig}`, projectId: PROJ, ts, enriched: true }, await embedFn(sig))
  }

  // run 1 — extract "use Redis hot-window"
  const c1 = clientReturning(JSON.stringify({ decisions: [{ statement: 'use Redis hot-window', rationale: 'low latency', confidence: 0.8, supersedes: [] }] }))
  const r1 = await maybeExtractDecisions(store as SqliteStore, PROJ, { minNewChunks: 1, client: c1, embedFn })
  check('run 1 inserted a decision', r1 === true)
  const a1 = store.queryActiveDecisions(PROJ, 10)
  check('decision active + has rationale', a1.length === 1 && a1[0]!.rationale === 'low latency')
  const d1id = a1[0]!.id
  check('realized_by edges to t1,t2', store.getEdgeNeighbors('t1', 10).some(e => e.edgeType === 'realized_by'))
  check('decision found by vector', store.queryDecisionsByVector(PROJ, await embedFn('use Redis hot-window\nlow latency'), 5).some(d => d.id === d1id))

  // add more change-linked work so the threshold passes again (real epoch ts > prior decision.lastSeen)
  let ts2 = Date.now() + 1000
  for (const sig of ['t3', 't4']) {
    ts2++
    store.insertPromptSig({ sig, parentSig: null, promptText: 'p:' + sig, sessionId: 's', source: 'claude-code', projectId: PROJ, ts: ts2 })
    store.insertChange({ sig, file: 'cache.ts', symbol: 'hotWindow', changeType: 'modified' })
    store.insertContextChunk({ id: `${sig}:ctx`, sig, text: `dropped redis in ${sig}`, projectId: PROJ, ts: ts2, enriched: true }, await embedFn(sig))
  }

  // run 2 — "drop Redis" supersedes d1
  const c2 = clientReturning(JSON.stringify({ decisions: [{ statement: 'drop Redis, go SQLite-only', rationale: 'one store, determinism', confidence: 0.9, supersedes: [d1id] }] }))
  const r2 = await maybeExtractDecisions(store as SqliteStore, PROJ, { minNewChunks: 1, client: c2, embedFn })
  check('run 2 inserted superseding decision', r2 === true)
  const active = store.queryActiveDecisions(PROJ, 10).map(d => d.statement)
  check('old decision superseded (excluded from current)', !active.includes('use Redis hot-window') && active.includes('drop Redis, go SQLite-only'), active.join(' | '))
  check('supersedes edge exists', store.getEdgeNeighbors(`dec:${d1id}`, 10).some(e => e.edgeType === 'supersedes'))

  // junk guard: empty statement is skipped
  let ts3 = Date.now() + 100000
  for (const sig of ['t5', 't6']) { ts3++; store.insertPromptSig({ sig, parentSig: null, promptText: 'p', sessionId: 's', source: 'claude-code', projectId: PROJ, ts: ts3 }); store.insertChange({ sig, file: 'x.ts', symbol: 'y', changeType: 'modified' }); store.insertContextChunk({ id: `${sig}:ctx`, sig, text: 'noise', projectId: PROJ, ts: ts3, enriched: true }, await embedFn(sig)) }
  const cJunk = clientReturning(JSON.stringify({ decisions: [{ statement: '', rationale: '', confidence: 0.5 }] }))
  const before = store.queryActiveDecisions(PROJ, 50).length
  await maybeExtractDecisions(store as SqliteStore, PROJ, { minNewChunks: 1, client: cJunk, embedFn })
  check('junk (empty statement) skipped', store.queryActiveDecisions(PROJ, 50).length === before)

  console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass}/${pass + fail} passed\x1b[0m\n`)
  process.exit(fail === 0 ? 0 : 1)
}
main()

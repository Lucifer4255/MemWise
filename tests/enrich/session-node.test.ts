// Layer 14 #4 — night-shift builds session GRAPH NODES (not just flat rows).
// Stubs the generate client + embedFn so it runs without Ollama. Run: npx tsx tests/enrich/session-node.test.ts
import { openDatabase } from '../../src/core/db.js'
import { maybeConsolidate } from '../../src/enrich/episodic.js'
import { EMBED_DIM } from '../../src/core/config.js'
import type { SqliteStore } from '../../src/store/sqlite-store.js'

const { store } = openDatabase(':memory:')
const PROJ = 'p1'
let pass = 0, fail = 0
const check = (l: string, c: boolean, d = '') => { console.log(`  ${c ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'}  ${l}${d ? '   ' + d : ''}`); c ? pass++ : fail++ }

// stub GenerateClient: always available, returns a fixed recap
const fakeClient = {
  isAvailable: () => Promise.resolve(true),
  generate: () => Promise.resolve('Built the auth flow across webhook.ts and handler.ts.'),
} as unknown as import('../../src/embed/generate-client.js').GenerateClient
const embedFn = (t: string) => Promise.resolve(Array.from({ length: EMBED_DIM }, (_, i) => Math.sin(t.length + i)))

// seed turns (members of the session)
let ts = 1000
for (const sig of ['t1', 't2', 't3']) {
  ts++
  store.insertPromptSig({ sig, parentSig: null, promptText: 'p:' + sig, sessionId: 's', source: 'claude-code', projectId: PROJ, ts })
}

async function main() {
  // chunks with real (awaited) vectors so countChunksSince + vector search work
  let cts = 1000
  for (const sig of ['t1', 't2', 't3']) {
    cts++
    const e = await embedFn(`work in ${sig}`)
    store.insertContextChunk({ id: `${sig}:ctx`, sig, text: `work in ${sig}`, projectId: PROJ, ts: cts, enriched: true }, e)
  }

  const ran = await maybeConsolidate(store as SqliteStore, PROJ, { minNewChunks: 1, client: fakeClient, embedFn })
  check('consolidation ran', ran === true)

  // a session node now exists and is vector-searchable
  const q = await embedFn('auth flow webhook')
  const nodes = store.querySessionNodesByVector(PROJ, q, 5)
  check('session node is vector-searchable', nodes.length === 1, `found ${nodes.length}`)
  check('summary persisted on node', nodes[0]?.summary.includes('auth flow'))

  // summarizes edges link the node to its 3 member turns
  const members = nodes[0] ? store.getSessionMemberTurns(nodes[0].nodeSig) : []
  check('summarizes → 3 member turns', members.sort().join(',') === 't1,t2,t3', members.join(','))

  // idempotent: same window re-consolidated updates ONE node (no duplicate)
  await maybeConsolidate(store as SqliteStore, PROJ, { minNewChunks: 0, client: fakeClient, embedFn })
  check('re-run does not duplicate the node', store.querySessionNodesByVector(PROJ, q, 5).length === 1)

  // queryLatestSessionSummary still works (back-compat)
  check('latest session summary back-compat', store.queryLatestSessionSummary(PROJ)?.summary.includes('auth flow') === true)

  console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass}/${pass + fail} passed\x1b[0m\n`)
  process.exit(fail === 0 ? 0 : 1)
}
main()

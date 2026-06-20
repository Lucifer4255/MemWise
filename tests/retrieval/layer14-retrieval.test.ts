// Layer 14 #6/#7 — coarse-to-fine session retrieval + decision attach (current vs superseded).
// Run: MEMWISE_DECISION_TIER=on npx tsx tests/retrieval/layer14-retrieval.test.ts
import { openDatabase } from '../../src/core/db.js'
import { retrieve } from '../../src/retrieval/retrieve.js'
import { EMBED_DIM, DECISION_TIER_ENABLED } from '../../src/core/config.js'
import type { EmbedFn } from '../../src/embed/ollama-client.js'

const { store } = openDatabase(':memory:')
const PROJ = 'p1'
let pass = 0, fail = 0
const check = (l: string, c: boolean, d = '') => { console.log(`  ${c ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'}  ${l}${d ? '   ' + d : ''}`); c ? pass++ : fail++ }

if (!DECISION_TIER_ENABLED) { console.error('\n  run with MEMWISE_DECISION_TIER=on\n'); process.exit(2) }

// Deterministic embeddings keyed by a tag in the text → controllable similarity.
// "auth" texts cluster near vec('auth'); "cache" near vec('cache'); orthogonal-ish.
const basis = (tag: string) => { const v = new Array(EMBED_DIM).fill(0.01); v[tag === 'auth' ? 0 : 1] = 1; return v }
const embedFn: EmbedFn = (t: string) => Promise.resolve(basis(t.includes('auth') ? 'auth' : 'cache'))

async function main() {
  // Two turns: t1 (auth) is directly findable; t2 (auth) has WEAK text but belongs to an auth session.
  let ts = 1000
  const seed = async (sig: string, text: string) => {
    ts++
    store.insertPromptSig({ sig, parentSig: null, promptText: text, sessionId: 's', source: 'claude-code', projectId: PROJ, ts })
    store.insertContextChunk({ id: `${sig}:ctx`, sig, text, projectId: PROJ, ts, enriched: true }, await embedFn(text))
  }
  await seed('t1', 'auth login token verification')
  // 8 auth-cluster distractors so the base top-K is FULL of nearer turns — t2 gets pushed out.
  for (let i = 0; i < 8; i++) await seed(`d${i}`, `auth helper ${i}`)
  await seed('t2', 'misc tweak')           // weak text + cache-cluster vector → NOT in base top-K
  await seed('c1', 'cache redis hot window') // unrelated cluster

  // Session node groups t1 + t2 under an "auth" summary, embedded in the auth cluster.
  store.upsertSessionNode(
    { nodeSig: 'sess:auth1', projectId: PROJ, source: 'nightshift', sigRange: 't1..t2', summary: 'auth flow work', ts: 2000 },
    await embedFn('auth flow work'),
  )
  for (const m of ['t1', 't2']) store.insertTurnEdgeOrIgnore({ fromSig: 'sess:auth1', toSig: m, edgeType: 'summarizes', label: '', ts: 2000 })

  // ── coarse-to-fine: a small base top-K excludes t2 (far text); only the session drill reaches it ──
  const res = await retrieve('auth flow', { projectId: PROJ, store, embedFn, mode: 'semantic', hybridLimit: 4 })
  const t2anchor = res.anchors.find(a => a.sig === 't2')
  check('direct match t1 present', res.anchors.some(a => a.sig === 't1'))
  check('coarse-to-fine reaches t2', !!t2anchor, res.anchors.map(a => a.sig).join(','))
  check('t2 surfaced specifically via session drill', t2anchor?.sources.includes('session') === true, JSON.stringify(t2anchor?.sources))

  // ── decisions: current shows, superseded hidden ──
  const now = Date.now()
  store.upsertDecision({ id: 'd1', projectId: PROJ, statement: 'use Redis hot-window', rationale: 'latency', confidence: 0.8, createdTs: now, lastSeen: now, supersededBy: '' }, await embedFn('cache redis'))
  store.upsertDecision({ id: 'd2', projectId: PROJ, statement: 'drop Redis, SQLite-only', rationale: 'one store', confidence: 0.9, createdTs: now, lastSeen: now, supersededBy: '' }, await embedFn('cache redis'))
  store.markDecisionSuperseded('d1', 'd2', now)

  const res2 = await retrieve('cache redis', { projectId: PROJ, store, embedFn, mode: 'semantic', hybridLimit: 5 })
  check('current decision d2 in block', res2.block.includes('drop Redis'))
  check('superseded decision d1 NOT in block', !res2.block.includes('use Redis hot-window'), 'block has stale decision')
  check('Decisions section rendered', res2.block.includes('### Decisions'))

  console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass}/${pass + fail} passed\x1b[0m\n`)
  process.exit(fail === 0 ? 0 : 1)
}
main()

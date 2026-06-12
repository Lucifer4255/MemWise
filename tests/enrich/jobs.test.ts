import { openDatabase } from '../../src/core/db.js'
import { GenerateClient } from '../../src/embed/generate-client.js'
import { maybeExtractSemantic } from '../../src/enrich/semantic.js'
import { maybeExtractProcedural } from '../../src/enrich/procedural.js'
import { buildMaterial, isJunkText } from '../../src/enrich/consolidate-utils.js'
import type { SqliteStore } from '../../src/store/sqlite-store.js'

type TestResult = { name: string; ok: boolean; detail: string }
const pass = (name: string, detail = ''): TestResult => ({ name, ok: true, detail })
const fail = (name: string, detail: string): TestResult => ({ name, ok: false, detail })

/** A GenerateClient that reports available and returns canned JSON — exercises Jobs 3/4 with no Ollama. */
function fakeModelClient(json: string): GenerateClient {
  const c = new GenerateClient('http://127.0.0.1:1', 'fake')
  ;(c as unknown as { isAvailable: () => Promise<boolean> }).isAvailable = async () => true
  ;(c as unknown as { generate: () => Promise<string> }).generate = async () => json
  return c
}

const PROJ = 'proj-jobs'
function seedChunk(store: SqliteStore, sig: string, text: string, ts: number): void {
  store.insertPromptSig({ sig, parentSig: null, promptText: 'p:' + sig, sessionId: 's', source: 'claude-code', projectId: PROJ, ts })
  store.insertContextChunk({ id: `${sig}:ctx`, sig, text, projectId: PROJ, ts, enriched: true }, [])
}

async function main(): Promise<void> {
  const results: TestResult[] = []

  // ── util: isJunkText rejects placeholders, keeps real statements ──
  {
    const junk = ['...', '', '  ', '--', 'ok'].every(isJunkText)
    const real = !isJunkText('Persistence uses better-sqlite3 with sqlite-vec')
    results.push(junk && real ? pass('isJunkText guard', 'placeholders rejected, real kept') : fail('isJunkText guard', `junk=${junk} real=${real}`))
  }

  // ── util: buildMaterial dedupes identical lines (small models abstain on dup-heavy input) ──
  {
    const m = buildMaterial(['s1'], ['note A', 'note A', 'note B', 'NOTE A'])
    const noteCount = (m.match(/\[note\]/g) ?? []).length
    results.push(noteCount === 2 ? pass('buildMaterial dedup', '4 raw notes → 2 unique') : fail('buildMaterial dedup', `noteCount=${noteCount} :: ${m}`))
  }

  // ── util: buildMaterial clips oversized summaries (whole summaries overflow a small model's ctx) ──
  {
    const huge = 'x'.repeat(5000)
    const m = buildMaterial([huge], ['short note'])
    const summaryLine = m.split('\n\n').find(l => l.startsWith('[summary]'))!
    results.push(
      summaryLine.length < 1000 && summaryLine.endsWith('…')
        ? pass('buildMaterial clips', `5000-char summary → ${summaryLine.length} chars`)
        : fail('buildMaterial clips', `len=${summaryLine.length}`),
    )
  }

  // ── Job 3: extract a new semantic fact ──
  {
    const { store } = openDatabase(':memory:')
    seedChunk(store, 'a'.repeat(64), 'switched persistence to better-sqlite3 with sqlite-vec', 5000)
    const wrote = await maybeExtractSemantic(store, PROJ, {
      minNewChunks: 1,
      client: fakeModelClient('{"newFacts":[{"fact":"Persistence uses better-sqlite3 + sqlite-vec","confidence":0.9}],"reinforced":[],"contradicted":[]}'),
    })
    const facts = store.querySemanticFacts(PROJ, 10)
    results.push(
      wrote && facts.length === 1 && facts[0]!.fact.includes('better-sqlite3')
        ? pass('Job 3 extract fact', `1 fact stored`)
        : fail('Job 3 extract fact', `wrote=${wrote} facts=${JSON.stringify(facts)}`),
    )
  }

  // ── Job 3: reinforce existing + contradict (delete) ──
  {
    const { store } = openDatabase(':memory:')
    const recent = Date.now() - 1000 // recent → not evictable
    store.upsertSemanticFact({ id: 'keep', projectId: PROJ, fact: 'keep me', confidence: 0.6, lastSeen: recent })
    store.upsertSemanticFact({ id: 'gone', projectId: PROJ, fact: 'stale wrong fact', confidence: 0.6, lastSeen: recent })
    seedChunk(store, 'b'.repeat(64), 'reaffirmed keep me; removed the wrong assumption', Date.now())
    await maybeExtractSemantic(store, PROJ, {
      minNewChunks: 1,
      client: fakeModelClient('{"newFacts":[],"reinforced":["keep"],"contradicted":["gone"]}'),
    })
    const facts = store.querySemanticFacts(PROJ, 10)
    const keep = facts.find(f => f.id === 'keep')
    results.push(
      facts.length === 1 && keep?.support === 1
        ? pass('Job 3 reinforce+contradict', 'keep support=1, gone deleted')
        : fail('Job 3 reinforce+contradict', JSON.stringify(facts)),
    )
  }

  // ── Job 3: eviction of decayed fact ──
  {
    const { store } = openDatabase(':memory:')
    store.upsertSemanticFact({ id: 'anchor', projectId: PROJ, fact: 'recent anchor', confidence: 0.6, lastSeen: Date.now() - 1000 })
    store.upsertSemanticFact({ id: 'stale', projectId: PROJ, fact: 'ancient', confidence: 0.6, lastSeen: 0 }) // ~1970 → decays to ~0
    seedChunk(store, 'c'.repeat(64), 'some new work', Date.now())
    await maybeExtractSemantic(store, PROJ, {
      minNewChunks: 1,
      client: fakeModelClient('{"newFacts":[],"reinforced":[],"contradicted":[]}'),
    })
    const ids = store.querySemanticFacts(PROJ, 10).map(f => f.id)
    results.push(
      !ids.includes('stale') && ids.includes('anchor')
        ? pass('Job 3 eviction', 'decayed fact pruned, anchor kept')
        : fail('Job 3 eviction', ids.join(',')),
    )
  }

  // ── Job 3: graceful on bad JSON ──
  {
    const { store } = openDatabase(':memory:')
    seedChunk(store, 'd'.repeat(64), 'work', 5000)
    let threw = false
    let wrote = true
    try {
      wrote = await maybeExtractSemantic(store, PROJ, { minNewChunks: 1, client: fakeModelClient('not json at all') })
    } catch {
      threw = true
    }
    results.push(
      !threw && !wrote && store.querySemanticFacts(PROJ, 10).length === 0
        ? pass('Job 3 bad-JSON graceful', 'no throw, no rows')
        : fail('Job 3 bad-JSON graceful', `threw=${threw} wrote=${wrote}`),
    )
  }

  // ── Job 4: extract a procedural pattern ──
  {
    const { store } = openDatabase(':memory:')
    seedChunk(store, 'e'.repeat(64), 'to add an endpoint we define the route, controller, service, then a test', 5000)
    const wrote = await maybeExtractProcedural(store, PROJ, {
      minNewChunks: 1,
      client: fakeModelClient('{"newPatterns":[{"pattern":"add an HTTP endpoint","sequence":["route","controller","service","test"]}],"reinforced":[]}'),
    })
    const procs = store.queryProcedural(PROJ, 10)
    results.push(
      wrote && procs.length === 1 && JSON.parse(procs[0]!.sequence).length === 4
        ? pass('Job 4 extract pattern', '1 pattern, 4 steps')
        : fail('Job 4 extract pattern', `wrote=${wrote} procs=${JSON.stringify(procs)}`),
    )
  }

  // ── Job 3: junk fact ("...") is not stored ──
  {
    const { store } = openDatabase(':memory:')
    seedChunk(store, '1'.repeat(64), 'real durable note about the architecture', 5000)
    const wrote = await maybeExtractSemantic(store, PROJ, {
      minNewChunks: 1,
      client: fakeModelClient('{"newFacts":[{"fact":"...","confidence":1},{"fact":"Uses RRF to fuse vector and FTS5","confidence":0.9}],"reinforced":[],"contradicted":[]}'),
    })
    const facts = store.querySemanticFacts(PROJ, 10)
    results.push(
      wrote && facts.length === 1 && facts[0]!.fact.includes('RRF')
        ? pass('Job 3 junk fact filtered', 'placeholder "..." dropped, real fact kept')
        : fail('Job 3 junk fact filtered', JSON.stringify(facts)),
    )
  }

  // ── Job 4: hallucinated reinforced id ([""]) must NOT report success ──
  {
    const { store } = openDatabase(':memory:')
    seedChunk(store, '2'.repeat(64), 'some notes with no clear procedure', 5000)
    const wrote = await maybeExtractProcedural(store, PROJ, {
      minNewChunks: 1,
      client: fakeModelClient('{"newPatterns":[],"reinforced":[""]}'),
    })
    results.push(
      !wrote && store.queryProcedural(PROJ, 10).length === 0
        ? pass('Job 4 no false-positive', 'empty + junk reinforced id → returns false')
        : fail('Job 4 no false-positive', `wrote=${wrote} (should be false)`),
    )
  }

  // ── gate: below threshold → no-op (model not consulted) ──
  {
    const { store } = openDatabase(':memory:')
    seedChunk(store, 'f'.repeat(64), 'one note', 5000)
    const wrote = await maybeExtractSemantic(store, PROJ, {
      minNewChunks: 50,
      client: fakeModelClient('{"newFacts":[{"fact":"should not run","confidence":1}]}'),
    })
    results.push(
      !wrote && store.querySemanticFacts(PROJ, 10).length === 0
        ? pass('Job 3 threshold gate', 'no-op below minNewChunks')
        : fail('Job 3 threshold gate', `wrote=${wrote}`),
    )
  }

  console.log('\n── memwise consolidation jobs (3/4) tests ──\n')
  let passed = 0
  for (const r of results) {
    const icon = r.ok ? '✓' : '✗'
    const label = r.ok ? '\x1b[32m' : '\x1b[31m'
    console.log(`  ${label}${icon}\x1b[0m  ${r.name.padEnd(28)} ${r.detail}`)
    if (r.ok) passed++
  }
  console.log(`\n  ${passed}/${results.length} passed\n`)
  process.exit(passed === results.length ? 0 : 1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

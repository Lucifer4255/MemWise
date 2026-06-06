import { EMBED_DIM } from '../../src/core/config.js'
import { openDatabase } from '../../src/core/db.js'
import type { ContextChunk, PromptSig } from '../../src/store/memory-store.js'

type TestResult = { name: string; ok: boolean; detail: string }

function pass(name: string, detail = ''): TestResult {
  return { name, ok: true, detail }
}

function fail(name: string, detail: string): TestResult {
  return { name, ok: false, detail }
}

function fakeEmbedding(seed: number): number[] {
  const vec = new Array<number>(EMBED_DIM)
  for (let i = 0; i < EMBED_DIM; i++) {
    vec[i] = Math.sin(seed + i * 0.01)
  }
  return vec
}

function main(): void {
  const results: TestResult[] = []
  const { db, store } = openDatabase(':memory:')

  try {
    const sig: PromptSig = {
      sig: 'a'.repeat(64),
      parentSig: null,
      promptText: 'fix race condition in payment',
      sessionId: 'sess-1',
      source: 'claude-code',
      projectId: 'proj-1',
      ts: 1_700_000_000,
    }
    store.insertPromptSig(sig)
    const readBack = store.getPromptSig(sig.sig)
    if (!readBack || readBack.promptText !== sig.promptText) {
      results.push(fail('insert/read prompt_sig', 'row not read back correctly'))
    } else {
      results.push(pass('insert/read prompt_sig', `sig=${readBack.sig.slice(0, 8)}…`))
    }

    store.insertChange({
      sig: sig.sig,
      file: 'processor.ts',
      symbol: 'processPayment',
      changeType: 'modified',
    })
    const changes = store.queryChangesForSymbol('processPayment')
    if (changes.length !== 1 || changes[0]?.file !== 'processor.ts') {
      results.push(fail('insert/query change', `got ${changes.length} rows`))
    } else {
      results.push(pass('insert/query change', 'processPayment → processor.ts'))
    }

    const targetVec = fakeEmbedding(1)
    const chunk: ContextChunk = {
      id: 'chunk-1',
      sig: sig.sig,
      text: 'processPayment retries on webhook overlap',
      projectId: 'proj-1',
      ts: 1_700_000_001,
    }
    store.insertContextChunk(chunk, targetVec)

    const knnRows = db
      .prepare(
        `SELECT v.chunk_id AS id
         FROM chunk_vec v
         WHERE v.embedding MATCH ?
           AND k = 1
         ORDER BY distance`,
      )
      .all(Buffer.from(new Float32Array(targetVec).buffer)) as { id: string }[]

    if (knnRows.length !== 1 || knnRows[0]?.id !== chunk.id) {
      results.push(fail('KNN query', `expected chunk-1, got ${JSON.stringify(knnRows)}`))
    } else {
      results.push(pass('KNN query', 'k=1 → chunk-1'))
    }

    const ftsRows = db
      .prepare(
        `SELECT c.id
         FROM chunk_fts f
         INNER JOIN context_chunk c ON c.rowid = f.rowid
         WHERE chunk_fts MATCH ?
         LIMIT 5`,
      )
      .all('processPayment') as { id: string }[]

    if (ftsRows.length !== 1 || ftsRows[0]?.id !== chunk.id) {
      results.push(fail('FTS5 search', `expected chunk-1, got ${JSON.stringify(ftsRows)}`))
    } else {
      results.push(pass('FTS5 search', 'processPayment → chunk-1'))
    }

    store.insertSymbolDep({
      fromSymbol: 'processPayment',
      fromFile: 'processor.ts',
      toSymbol: 'handleWebhook',
      toFile: 'webhook.ts',
    })
    store.insertSymbolDep({
      fromSymbol: 'handleWebhook',
      fromFile: 'webhook.ts',
      toSymbol: 'verifySignature',
      toFile: 'auth.ts',
    })
    store.insertSymbolDep({
      fromSymbol: 'unrelated',
      fromFile: 'other.ts',
      toSymbol: 'noop',
      toFile: 'misc.ts',
    })

    // Blast radius = dependents (REVERSE): if verifySignature changes, who is affected?
    // handleWebhook calls verifySignature → processPayment calls handleWebhook → both affected.
    const blast = store.queryBlastRadius('verifySignature', 'auth.ts', 2)
    const affected = blast.map(edge => edge.fromSymbol).sort()
    const expected = ['handleWebhook', 'processPayment'].sort()

    if (affected.length !== 2 || affected.join(',') !== expected.join(',')) {
      results.push(
        fail('blast-radius CTE (reverse)', `expected ${expected.join(',')}, got ${affected.join(',')}`),
      )
    } else {
      results.push(pass('blast-radius CTE (reverse)', 'change verifySignature → affects handleWebhook, processPayment'))
    }

    // queryHybrid: exercise the public RRF path (not raw SQL). Add a second,
    // unrelated chunk far in vector space with no keyword overlap; the relevant
    // chunk must rank first.
    const farChunk: ContextChunk = {
      id: 'chunk-2',
      sig: sig.sig,
      text: 'unrelated logging configuration tweak',
      projectId: 'proj-1',
      ts: 1_700_000_002,
    }
    store.insertContextChunk(farChunk, fakeEmbedding(500))

    const hybrid = store.queryHybrid(targetVec, 'processPayment webhook overlap', 5)
    if (hybrid.length === 0 || hybrid[0]?.id !== 'chunk-1') {
      results.push(
        fail('queryHybrid RRF', `expected chunk-1 first, got ${JSON.stringify(hybrid.map(c => c.id))}`),
      )
    } else {
      results.push(pass('queryHybrid RRF', `vec+fts fused → chunk-1 first (${hybrid.length} hits)`))
    }

    // FTS5 special-char / keyword safety: real prompts contain @paths, [brackets], hyphens, and
    // the literal words and/or/not — none may throw "fts5: syntax error". (Regression: eval harness.)
    const gnarlyQueries = [
      'remove gap in @src/components/popup.tsx',
      'fix the [config] and (setup) issue',
      'handle this AND that OR the other NOT none',
      'rate-limit the api/v2 endpoint',
      '"""', // pure punctuation → must not throw
    ]
    let ftsSafe = true
    let ftsErr = ''
    for (const q of gnarlyQueries) {
      try {
        store.queryHybrid(targetVec, q, 5)
      } catch (e) {
        ftsSafe = false
        ftsErr = `${q} → ${String(e)}`
        break
      }
    }
    results.push(
      ftsSafe
        ? pass('FTS5 special-char safety', 'paths/brackets/hyphens/keywords never throw')
        : fail('FTS5 special-char safety', ftsErr),
    )

    // Deleting a context_chunk must evict its vector (trigger) — no orphan in chunk_vec.
    db.prepare(`DELETE FROM context_chunk WHERE id = ?`).run('chunk-2')
    const orphan = db
      .prepare(`SELECT chunk_id FROM chunk_vec WHERE chunk_id = ?`)
      .all('chunk-2') as { chunk_id: string }[]
    if (orphan.length !== 0) {
      results.push(fail('vec cleanup on delete', `chunk-2 vector orphaned (${orphan.length} rows)`))
    } else {
      results.push(pass('vec cleanup on delete', 'chunk_vec row evicted with context_chunk'))
    }
    // ── queryRecentMessagesScoped ─────────────────────────────────────────────
    const sig2: PromptSig = {
      sig: 'b'.repeat(64),
      parentSig: null,
      promptText: 'other project prompt',
      sessionId: 'sess-2',
      source: 'claude-code',
      projectId: 'proj-other',
      ts: 1_700_000_002,
    }
    store.insertPromptSig(sig2)
    store.insertContextChunk(
      { id: 'chunk-other', sig: sig2.sig, text: 'other project note', projectId: 'proj-other', ts: 1_700_000_002 },
      fakeEmbedding(42),
    )
    const scoped = store.queryRecentMessagesScoped('proj-1', 50)
    if (scoped.length === 1 && scoped[0]?.projectId === 'proj-1') {
      results.push(pass('queryRecentMessagesScoped', 'returns only proj-1 messages'))
    } else {
      results.push(fail('queryRecentMessagesScoped', `got ${scoped.length} rows, projectIds: ${scoped.map(r => r.projectId).join(',')}`))
    }

    // ── semantic tier: upsert + reinforce (no dup) ────────────────────────────
    const now = 1_700_001_000_000
    store.upsertSemanticFact({ id: 'f1', projectId: 'proj-1', fact: 'uses better-sqlite3', confidence: 0.9, lastSeen: now })
    store.upsertSemanticFact({ id: 'f1', projectId: 'proj-1', fact: 'uses better-sqlite3', confidence: 0.9, lastSeen: now }) // dup id → ignored
    store.reinforceSemanticFact('f1', 0.95, now + 1000)
    const facts1 = store.querySemanticFacts('proj-1', 10)
    if (facts1.length === 1 && facts1[0]!.support === 1 && facts1[0]!.confidence === 0.95) {
      results.push(pass('semantic upsert+reinforce', `1 row, support=1, conf=0.95`))
    } else {
      results.push(fail('semantic upsert+reinforce', JSON.stringify(facts1)))
    }

    // ── semantic decay ordering: recent/strong ranks above old/weak ───────────
    store.upsertSemanticFact({ id: 'f-old', projectId: 'proj-1', fact: 'stale fact', confidence: 0.5, lastSeen: now - 400 * 86_400_000 })
    const ranked = store.querySemanticFacts('proj-1', 10)
    if (ranked[0]!.id === 'f1' && ranked[ranked.length - 1]!.id === 'f-old') {
      results.push(pass('semantic decay ordering', 'fresh/strong > old/weak'))
    } else {
      results.push(fail('semantic decay ordering', ranked.map(f => f.id).join(',')))
    }

    // ── procedural: upsert + reinforce + sequence round-trip ───────────────────
    store.upsertProcedural({ id: 'p1', projectId: 'proj-1', pattern: 'add endpoint', sequence: JSON.stringify(['route', 'controller', 'test']), lastSeen: now })
    store.reinforceProcedural('p1', now + 1000)
    const procs = store.queryProcedural('proj-1', 10)
    if (procs.length === 1 && procs[0]!.freq === 1 && JSON.parse(procs[0]!.sequence).length === 3) {
      results.push(pass('procedural upsert+reinforce', 'freq=1, 3-step sequence'))
    } else {
      results.push(fail('procedural upsert+reinforce', JSON.stringify(procs)))
    }

    // ── delete ─────────────────────────────────────────────────────────────────
    store.deleteSemanticFact('f-old')
    store.deleteProcedural('p1')
    if (store.querySemanticFacts('proj-1', 10).length === 1 && store.queryProcedural('proj-1', 10).length === 0) {
      results.push(pass('semantic/procedural delete', 'rows removed'))
    } else {
      results.push(fail('semantic/procedural delete', 'delete did not remove rows'))
    }

    // ── queryProjects counts facts + patterns ──────────────────────────────────
    const projects = store.queryProjects()
    const proj1Row = projects.find(p => p.projectId === 'proj-1')
    const projOtherRow = projects.find(p => p.projectId === 'proj-other')
    if (projects.length === 2 && proj1Row && projOtherRow && proj1Row.messages >= 1 && proj1Row.facts === 1 && proj1Row.patterns === 0) {
      results.push(pass('queryProjects', `proj-1 messages=${proj1Row.messages} facts=${proj1Row.facts} patterns=${proj1Row.patterns}`))
    } else {
      results.push(fail('queryProjects', JSON.stringify(projects)))
    }

  } finally {
    db.close()
  }

  console.log('\n── memwise Layer 1 store tests ──\n')
  let passed = 0
  for (const r of results) {
    const icon = r.ok ? '✓' : '✗'
    const label = r.ok ? '\x1b[32m' : '\x1b[31m'
    console.log(`  ${label}${icon}\x1b[0m  ${r.name.padEnd(24)} ${r.detail}`)
    if (r.ok) passed++
  }
  console.log(`\n  ${passed}/${results.length} passed\n`)
  process.exit(passed === results.length ? 0 : 1)
}

main()

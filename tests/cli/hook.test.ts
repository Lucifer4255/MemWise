import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureFromTranscript } from '../../src/capture/turn-capture.js'
import { EMBED_DIM } from '../../src/core/config.js'
import { GenerateClient } from '../../src/embed/generate-client.js'
import { Enricher } from '../../src/enrich/enricher.js'
import { openDatabase } from '../../src/core/db.js'
import { projectIdFromPath } from '../../src/core/project.js'

type TestResult = { name: string; ok: boolean; detail: string }
const pass = (name: string, detail = ''): TestResult => ({ name, ok: true, detail })
const fail = (name: string, detail: string): TestResult => ({ name, ok: false, detail })

function detEmbed(text: string): Promise<number[]> {
  const h = createHash('sha256').update(text).digest()
  return Promise.resolve(Array.from({ length: EMBED_DIM }, (_, i) => (h[i % h.length]! / 255) * 2 - 1))
}

/** An Enricher whose model is "unavailable" — exercises the graceful raw-text path, no network. */
function offlineEnricher(): Enricher {
  const fakeFetch = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch
  return new Enricher(new GenerateClient('http://127.0.0.1:1', 'none', fakeFetch))
}

const CWD = '/tmp/hook-capture-proj'
const SID = 'capture-fixture'

/** Build a transcript. `withStop=false` omits the trailing user turn so the LAST turn only closes
 *  via the EOF-synthesised Stop — modelling a cancelled turn where no real Stop fired. */
function fixture(opts: { secondTurn: boolean } = { secondTurn: true }): string {
  const rows: Record<string, unknown>[] = [
    { type: 'user', message: { content: 'add a retry loop to processPayment' }, sessionId: SID, cwd: CWD, timestamp: '2026-06-01T10:00:00Z' },
    { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'Adding exponential backoff to processPayment.' }] }, sessionId: SID, cwd: CWD, timestamp: '2026-06-01T10:00:01Z' },
    { type: 'assistant', uuid: 'a2', message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'pay.ts', content: 'function processPayment() { return retry() }\nfunction retry() { return 1 }\n' } }] }, sessionId: SID, cwd: CWD, timestamp: '2026-06-01T10:00:02Z' },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }, sessionId: SID, cwd: CWD, timestamp: '2026-06-01T10:00:03Z' },
  ]
  if (opts.secondTurn) {
    rows.push(
      { type: 'user', message: { content: 'now write tests for retry' }, sessionId: SID, cwd: CWD, timestamp: '2026-06-01T10:01:00Z' },
      { type: 'assistant', uuid: 'a3', message: { content: [{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: 'pay.test.ts', content: "test('retry', () => {})\n" } }] }, sessionId: SID, cwd: CWD, timestamp: '2026-06-01T10:01:02Z' },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] }, sessionId: SID, cwd: CWD, timestamp: '2026-06-01T10:01:03Z' },
    )
  }
  return rows.map(r => JSON.stringify(r)).join('\n') + '\n'
}

async function main(): Promise<void> {
  const results: TestResult[] = []
  const dir = mkdtempSync(join(tmpdir(), 'memwise-hook-'))
  const path = join(dir, 'transcript.jsonl')
  writeFileSync(path, fixture())
  const projectId = projectIdFromPath(CWD)

  // ── Test 1: capture writes the spine atomically (prompt_sig + change + context_chunk + vector) ──
  {
    const { db, store } = openDatabase(':memory:')
    const r = await captureFromTranscript(path, { store, embedFn: detEmbed, enricher: offlineEnricher(), skipConsolidate: true })
    const n = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n
    const vecRows = n('chunk_vec')
    if (r.captured === 2 && n('prompt_sig') === 2 && n('change') >= 2 && n('context_chunk') === 2 && vecRows === 2) {
      results.push(pass('transcript capture (atomic spine)', `${r.captured} msgs, ${vecRows} vectors`))
    } else {
      results.push(fail('transcript capture (atomic spine)', `captured=${r.captured} sig=${n('prompt_sig')} change=${n('change')} chunk=${n('context_chunk')} vec=${vecRows}`))
    }
    db.close()
  }

  // ── Test 2: idempotent — a second capture writes nothing new ──
  {
    const { store } = openDatabase(':memory:')
    await captureFromTranscript(path, { store, embedFn: detEmbed, enricher: offlineEnricher(), skipConsolidate: true })
    const second = await captureFromTranscript(path, { store, embedFn: detEmbed, enricher: offlineEnricher(), skipConsolidate: true })
    if (second.captured === 0 && second.turns >= 2) {
      results.push(pass('idempotent re-capture', `0 of ${second.turns} re-written`))
    } else {
      results.push(fail('idempotent re-capture', `captured=${second.captured} turns=${second.turns}`))
    }
  }

  // ── Test 3: cancel safety net — last turn has no real Stop, still captured via EOF boundary ──
  {
    const cancelPath = join(dir, 'cancelled.jsonl')
    writeFileSync(cancelPath, fixture({ secondTurn: false }))
    const { store } = openDatabase(':memory:')
    const r = await captureFromTranscript(cancelPath, { store, embedFn: detEmbed, enricher: offlineEnricher(), skipConsolidate: true })
    const got = store.getPromptSig.length >= 0 && r.captured === 1
    if (got) {
      results.push(pass('cancel safety net', 'turn with no real Stop captured'))
    } else {
      results.push(fail('cancel safety net', `captured=${r.captured}`))
    }
  }

  // ── Test 4: enrich graceful — no model → enriched=false but row + vector still written ──
  {
    const { db, store } = openDatabase(':memory:')
    await captureFromTranscript(path, { store, embedFn: detEmbed, enricher: offlineEnricher(), skipConsolidate: true })
    const row = db.prepare(`SELECT enriched, embedded FROM context_chunk LIMIT 1`).get() as { enriched: number; embedded: number }
    if (row.enriched === 0 && row.embedded === 1) {
      results.push(pass('enrich graceful fallback', 'enriched=0, embedded=1 (raw text, vector present)'))
    } else {
      results.push(fail('enrich graceful fallback', `enriched=${row.enriched} embedded=${row.embedded}`))
    }
    db.close()
  }

  // ── Test 5: telemetry emitted per captured message ──
  {
    const { store } = openDatabase(':memory:')
    await captureFromTranscript(path, { store, embedFn: detEmbed, enricher: offlineEnricher(), skipConsolidate: true })
    const tel = store.queryRecentTelemetry(0, 1000)
    const kinds = new Set(tel.map(t => t.kind))
    if (kinds.has('message') && kinds.has('embed') && kinds.has('enrich')) {
      results.push(pass('telemetry written', [...kinds].join(', ')))
    } else {
      results.push(fail('telemetry written', `kinds=${[...kinds].join(',')}`))
    }
  }

  // ── Test 6: postcompact session_summary still recorded + preferred fallback ──
  {
    const { store } = openDatabase(':memory:')
    store.insertSessionSummary({ projectId, source: 'postcompact', sigRange: '', summary: 'We added retry to processPayment.', ts: Date.now() })
    const s = store.queryLatestSessionSummary(projectId)
    if (s?.source === 'postcompact' && s.summary.includes('retry')) {
      results.push(pass('postcompact summary captured', `source=${s.source}`))
    } else {
      results.push(fail('postcompact summary captured', JSON.stringify(s)))
    }
  }

  console.log('\n── memwise capture / hook tests ──\n')
  let passed = 0
  for (const r of results) {
    const icon = r.ok ? '✓' : '✗'
    const label = r.ok ? '\x1b[32m' : '\x1b[31m'
    console.log(`  ${label}${icon}\x1b[0m  ${r.name.padEnd(34)} ${r.detail}`)
    if (r.ok) passed++
  }
  console.log(`\n  ${passed}/${results.length} passed\n`)
  process.exit(passed === results.length ? 0 : 1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

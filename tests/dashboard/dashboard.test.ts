import http from 'node:http'
import { openDatabase } from '../../src/core/db.js'
import { GenerateClient } from '../../src/embed/generate-client.js'
import { maybeConsolidate } from '../../src/enrich/episodic.js'
import { createDashboard } from '../../src/dashboard/server.js'

type TestResult = { name: string; ok: boolean; detail: string }
const pass = (name: string, detail = ''): TestResult => ({ name, ok: true, detail })
const fail = (name: string, detail: string): TestResult => ({ name, ok: false, detail })

function getJson(url: string): Promise<unknown> {
  return fetch(url).then(r => r.json())
}

function headOf(url: string): Promise<Record<string, string | string[] | undefined>> {
  return new Promise(resolve => {
    const req = http.get(url, r => {
      const h = r.headers
      r.destroy()
      resolve(h as Record<string, string | string[] | undefined>)
    })
    req.on('error', () => resolve({}))
  })
}

/** A GenerateClient that reports available and returns a canned merge — exercises Job 2 with no Ollama. */
function fakeModelClient(text: string): GenerateClient {
  const c = new GenerateClient('http://127.0.0.1:1', 'fake')
  ;(c as unknown as { isAvailable: () => Promise<boolean> }).isAvailable = async () => true
  ;(c as unknown as { generate: () => Promise<string> }).generate = async () => text
  return c
}

function seedMessage(store: ReturnType<typeof openDatabase>['store'], projectId: string, sig: string, text: string, ts: number): void {
  store.insertPromptSig({ sig, parentSig: null, promptText: 'p:' + sig, sessionId: 's', source: 'claude-code', projectId, ts })
  store.insertContextChunk({ id: `${sig}:ctx`, sig, text, projectId, ts, enriched: true }, [])
}

async function main(): Promise<void> {
  const results: TestResult[] = []
  const projectId = 'proj-dash'
  const { store } = openDatabase(':memory:')

  // Seed two messages + a telemetry row.
  seedMessage(store, projectId, 'a'.repeat(64), 'added retry to processPayment', 1_700_000_000)
  seedMessage(store, projectId, 'b'.repeat(64), 'wrote tests for retry path', 1_700_000_100)
  store.insertTelemetry('embed', { sig: 'a'.repeat(64), ms: 40, dim: 384 })
  store.insertTelemetry('embed', { sig: 'b'.repeat(64), ms: 60, dim: 384 })
  // Seed durable tiers (M2) so the semantic/procedural tabs have real rows.
  store.upsertSemanticFact({ id: 'fact-1', projectId, fact: 'retry uses exponential backoff', confidence: 0.9, lastSeen: Date.now() })
  store.upsertProcedural({ id: 'pat-1', projectId, pattern: 'add retry', sequence: JSON.stringify(['wrap', 'backoff', 'test']), lastSeen: Date.now() })

  const server = createDashboard({ store, port: 4391, pollMs: 80 })
  await new Promise(r => setTimeout(r, 120))
  const base = 'http://localhost:4391'

  // ── /api/recent ──
  {
    const rows = (await getJson(`${base}/api/recent`)) as { sig: string; text: string }[]
    if (rows.length === 2 && rows[0]!.text.includes('tests for retry')) {
      results.push(pass('/api/recent', `${rows.length} messages, newest first`))
    } else {
      results.push(fail('/api/recent', JSON.stringify(rows).slice(0, 160)))
    }
  }

  // ── /api/stats ──
  {
    const s = (await getJson(`${base}/api/stats`)) as { messages: number; avgEmbedMs: number | null }
    if (s.messages === 2 && s.avgEmbedMs === 50) {
      results.push(pass('/api/stats', `messages=${s.messages} avgEmbedMs=${s.avgEmbedMs}`))
    } else {
      results.push(fail('/api/stats', JSON.stringify(s)))
    }
  }

  // ── /events is an SSE stream ──
  {
    const h = await headOf(`${base}/events`)
    if (String(h['content-type']).includes('text/event-stream')) {
      results.push(pass('/events SSE', 'text/event-stream'))
    } else {
      results.push(fail('/events SSE', `content-type=${h['content-type']}`))
    }
  }

  // ── /events pushes a freshly-inserted telemetry row to a connected client ──
  {
    const got = await new Promise<boolean>(resolve => {
      let done = false
      const req = http.get(`${base}/events`, res => {
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          if (chunk.includes('job2') && !done) {
            done = true
            res.destroy()
            resolve(true)
          }
        })
      })
      req.on('error', () => resolve(false))
      // Insert after the client connects so the tail picks it up.
      setTimeout(() => store.insertTelemetry('job2', { projectId, inputs: 2, chars: 10 }), 120)
      setTimeout(() => { if (!done) { req.destroy(); resolve(false) } }, 1500)
    })
    results.push(got ? pass('/events live push', 'received job2 event') : fail('/events live push', 'no event received'))
  }

  // ── /api/projects ──
  {
    const projects = (await getJson(`${base}/api/projects`)) as { projectId: string; messages: number; summaries: number }[]
    if (Array.isArray(projects) && projects.some(p => p.projectId === projectId && p.messages >= 2)) {
      results.push(pass('/api/projects', `found ${projectId} with messages=${projects.find(p => p.projectId === projectId)?.messages}`))
    } else {
      results.push(fail('/api/projects', JSON.stringify(projects).slice(0, 160)))
    }
  }

  // ── /api/memories?tier=normal ──
  {
    const rows = (await getJson(`${base}/api/memories?project=${encodeURIComponent(projectId)}&tier=normal&limit=10`)) as { sig: string }[]
    if (Array.isArray(rows) && rows.length === 2) {
      results.push(pass('/api/memories normal', `${rows.length} rows for project`))
    } else {
      results.push(fail('/api/memories normal', JSON.stringify(rows).slice(0, 160)))
    }
  }

  // ── /api/memories?tier=episodic (no summaries yet → empty) ──
  {
    const rows = (await getJson(`${base}/api/memories?project=${encodeURIComponent(projectId)}&tier=episodic&limit=10`)) as unknown[]
    if (Array.isArray(rows) && rows.length === 0) {
      results.push(pass('/api/memories episodic empty', '[] before consolidation'))
    } else {
      results.push(fail('/api/memories episodic empty', JSON.stringify(rows).slice(0, 160)))
    }
  }

  // ── /api/memories?tier=semantic and procedural → real rows (M2) ──
  {
    const sem  = (await getJson(`${base}/api/memories?project=${encodeURIComponent(projectId)}&tier=semantic`))  as { fact: string }[]
    const proc = (await getJson(`${base}/api/memories?project=${encodeURIComponent(projectId)}&tier=procedural`)) as { pattern: string }[]
    if (sem.length === 1 && sem[0]!.fact.includes('backoff') && proc.length === 1 && proc[0]!.pattern === 'add retry') {
      results.push(pass('/api/memories semantic+procedural', '1 fact + 1 pattern returned'))
    } else {
      results.push(fail('/api/memories semantic+procedural', `sem=${JSON.stringify(sem)} proc=${JSON.stringify(proc)}`))
    }
  }

  server.close()

  // ── Job 2 episodic consolidation writes a nightshift summary ──
  {
    const wrote = await maybeConsolidate(store, projectId, {
      minNewChunks: 1,
      client: fakeModelClient('Recap: implemented and tested retry for processPayment.'),
    })
    const latest = store.queryLatestSessionSummary(projectId)
    if (wrote && latest?.source === 'nightshift' && latest.summary.includes('retry')) {
      results.push(pass('Job 2 episodic consolidation', 'nightshift summary written + preferred'))
    } else {
      results.push(fail('Job 2 episodic consolidation', `wrote=${wrote} latest=${JSON.stringify(latest)}`))
    }
  }

  // ── Job 2 gate: below threshold → no-op ──
  {
    const { store: s2 } = openDatabase(':memory:')
    seedMessage(s2, projectId, 'c'.repeat(64), 'one small note', 1_700_000_200)
    const wrote = await maybeConsolidate(s2, projectId, {
      minNewChunks: 5,
      client: fakeModelClient('should not be called'),
    })
    if (!wrote) {
      results.push(pass('Job 2 threshold gate', 'no-op below minNewChunks'))
    } else {
      results.push(fail('Job 2 threshold gate', 'consolidated despite too few chunks'))
    }
  }

  console.log('\n── memwise dashboard / episodic tests ──\n')
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

main().catch(err => {
  console.error(err)
  process.exit(1)
})

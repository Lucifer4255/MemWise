import { Enricher } from '../../src/enrich/enricher.js'
import { GenerateClient } from '../../src/embed/generate-client.js'
import type { FinalizedMessage } from '../../src/core/types.js'

type TestResult = { name: string; ok: boolean; detail: string }
const pass = (name: string, detail = ''): TestResult => ({ name, ok: true, detail })
const fail = (name: string, detail: string): TestResult => ({ name, ok: false, detail })

/** A GenerateClient that reports available and returns a canned TL;DR — exercises enrich with no Ollama. */
function fakeModelClient(tldr: string): GenerateClient {
  const c = new GenerateClient('http://127.0.0.1:1', 'fake')
  ;(c as unknown as { isAvailable: () => Promise<boolean> }).isAvailable = async () => true
  ;(c as unknown as { generate: () => Promise<string> }).generate = async () => tldr
  return c
}

function msg(partial: Partial<FinalizedMessage>): FinalizedMessage {
  return {
    sig: 'a'.repeat(64),
    parentSig: null,
    promptText: 'do the thing',
    contextText: 'raw captured narration about the work',
    codeChanges: [],
    symbolDeps: [],
    projectId: 'proj',
    sessionId: 's',
    source: 'claude-code',
    tsOpen: 0,
    ts: 1,
    ...partial,
  }
}

async function main(): Promise<void> {
  const results: TestResult[] = []

  // ── 1. No code changes → skip enrichment entirely, keep raw verbatim, no model call ──
  {
    let called = false
    const client = fakeModelClient('should not be used')
    ;(client as unknown as { generate: () => Promise<string> }).generate = async () => {
      called = true
      return 'SHOULD NOT APPEAR'
    }
    const enricher = new Enricher(client)
    const r = await enricher.enrich(msg({ codeChanges: [], contextText: 'pure discussion turn' }))
    if (!called && !r.enriched && r.text === 'pure discussion turn') {
      results.push(pass('no-code-change skip', 'raw kept, model not called'))
    } else {
      results.push(fail('no-code-change skip', `called=${called} enriched=${r.enriched} text=${JSON.stringify(r.text)}`))
    }
  }

  // ── 2. Code changes → TL;DR prepended, raw preserved verbatim below it ──
  {
    const enricher = new Enricher(fakeModelClient('Added retry to processPayment for duplicate webhooks.'))
    const raw = 'raw notes naming processPayment in processor.ts'
    const r = await enricher.enrich(
      msg({
        contextText: raw,
        codeChanges: [{ file: 'processor.ts', symbol: 'processPayment', changeType: 'modified' }],
      }),
    )
    const startsWithTldr = r.text.startsWith('TL;DR: Added retry to processPayment')
    const keepsRaw = r.text.includes(raw)
    if (r.enriched && startsWithTldr && keepsRaw) {
      results.push(pass('TL;DR prepend', 'summary on top, raw preserved verbatim'))
    } else {
      results.push(fail('TL;DR prepend', `enriched=${r.enriched} text=${JSON.stringify(r.text).slice(0, 120)}`))
    }
  }

  // ── 3. Model echoes a stray "TL;DR:" prefix → not doubled ──
  {
    const enricher = new Enricher(fakeModelClient('TL;DR: refactored the parser'))
    const r = await enricher.enrich(
      msg({ codeChanges: [{ file: 'p.ts', symbol: 'parse', changeType: 'modified' }] }),
    )
    if (!r.text.includes('TL;DR: TL;DR:')) {
      results.push(pass('no double TL;DR prefix', 'stray prefix stripped'))
    } else {
      results.push(fail('no double TL;DR prefix', r.text.slice(0, 80)))
    }
  }

  // ── 4. Empty model output → graceful fallback to raw ──
  {
    const enricher = new Enricher(fakeModelClient('   '))
    const r = await enricher.enrich(
      msg({ contextText: 'raw fallback', codeChanges: [{ file: 'p.ts', symbol: 'x', changeType: 'added' }] }),
    )
    if (!r.enriched && r.text === 'raw fallback') {
      results.push(pass('empty output fallback', 'falls back to raw'))
    } else {
      results.push(fail('empty output fallback', `enriched=${r.enriched} text=${JSON.stringify(r.text)}`))
    }
  }

  console.log('\n── memwise enricher (TL;DR) tests ──\n')
  let passed = 0
  for (const r of results) {
    const icon = r.ok ? '✓' : '✗'
    const label = r.ok ? '\x1b[32m' : '\x1b[31m'
    console.log(`  ${label}${icon}\x1b[0m  ${r.name.padEnd(26)} ${r.detail}`)
    if (r.ok) passed++
  }
  console.log(`\n  ${passed}/${results.length} passed\n`)
  process.exit(passed === results.length ? 0 : 1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

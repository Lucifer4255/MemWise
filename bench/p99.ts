/**
 * p99 benchmark — capture pipeline + retrieval pipeline.
 *
 * Capture bench: measures the SQLite write path (persistMessage) + embed (mocked at ~1ms)
 * because the Ollama RTT would dominate and isn't what we're measuring here.
 * Retrieval bench: measures the full retrieve() hot path (hybrid search + expand + format)
 * with pre-seeded rows and a mocked embed.
 *
 * Run: npx tsx src/bench/p99.ts
 * Optional: BENCH_N=500 npx tsx src/bench/p99.ts
 */

import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EMBED_DIM } from '../src/core/config.js'
import { openDatabase } from '../src/core/db.js'
import { persistMessage } from '../src/capture/persist.js'
import { retrieve } from '../src/retrieval/retrieve.js'
import type { FinalizedMessage } from '../src/core/types.js'

const N = parseInt(process.env.BENCH_N ?? '200', 10)
const WARM = Math.max(10, Math.floor(N * 0.1))

// ── helpers ──────────────────────────────────────────────────────────────────

function fakeVec(seed: number): number[] {
  const v = new Array<number>(EMBED_DIM)
  for (let i = 0; i < EMBED_DIM; i++) v[i] = Math.sin(seed + i * 0.01)
  return v
}

function fakeSig(): string {
  return randomBytes(8).toString('hex')
}

function fakeMsg(sig: string, projectId: string, ts: number): FinalizedMessage {
  return {
    sig,
    parentSig: null,
    promptText: `implement feature ${sig.slice(0, 6)}: add retry logic with exponential backoff`,
    sessionId: 'bench-session',
    source: 'claude-code',
    projectId,
    tsOpen: ts,
    ts,
    codeChanges: [
      { file: `/repo/src/${sig.slice(0, 6)}.ts`, symbol: 'retryFetch', changeType: 'modified' },
      { file: `/repo/src/utils.ts`, symbol: 'sleep', changeType: 'added' },
    ],
    symbolDeps: [],
    contextText: `Modified retryFetch in ${sig.slice(0, 6)}.ts to add exponential backoff. Added sleep utility to utils.ts. Retries up to 3 times with 2^n * 100ms delay.`,
  }
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, idx)]!
}

function stats(label: string, samples: number[]): void {
  const sorted = [...samples].sort((a, b) => a - b)
  const mean = samples.reduce((s, x) => s + x, 0) / samples.length
  console.log(
    `  ${label.padEnd(28)}` +
    `  p50=${percentile(sorted, 50).toFixed(1).padStart(7)}ms` +
    `  p95=${percentile(sorted, 95).toFixed(1).padStart(7)}ms` +
    `  p99=${percentile(sorted, 99).toFixed(1).padStart(7)}ms` +
    `  mean=${mean.toFixed(1).padStart(7)}ms` +
    `  min=${sorted[0]!.toFixed(1).padStart(6)}ms` +
    `  max=${sorted[sorted.length - 1]!.toFixed(1).padStart(7)}ms` +
    `  n=${samples.length}`,
  )
}

// ── bench: capture (persistMessage) ──────────────────────────────────────────

function benchCapture(): number[] {
  const dir = mkdtempSync(join(tmpdir(), 'mw-bench-'))
  try {
    const { store } = openDatabase(join(dir, 'bench.db'))
    const projectId = '/repo'
    const samples: number[] = []

    // warm-up
    for (let i = 0; i < WARM; i++) {
      const sig = fakeSig()
      persistMessage(store, fakeMsg(sig, projectId, Date.now()), `context ${i}`, fakeVec(i), false)
    }

    for (let i = 0; i < N; i++) {
      const sig = fakeSig()
      const msg = fakeMsg(sig, projectId, Date.now())
      const text = `enriched context for turn ${i}: retry logic, backoff, utils refactor.`
      const vec = fakeVec(i)
      const t0 = performance.now()
      persistMessage(store, msg, text, vec, true)
      samples.push(performance.now() - t0)
    }

    return samples
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── bench: retrieve (full pipeline, mocked embed) ────────────────────────────

async function benchRetrieve(): Promise<{ semantic: number[]; recency: number[]; session: number[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'mw-bench-'))
  try {
    const { store } = openDatabase(join(dir, 'bench.db'))
    const projectId = '/repo'

    // Seed 300 rows so there's a real workload for the search
    for (let i = 0; i < 300; i++) {
      const sig = fakeSig()
      const msg = fakeMsg(sig, projectId, Date.now() - (300 - i) * 60_000)
      persistMessage(store, msg, `context for turn ${i}: add retry, backoff, exponential sleep utility`, fakeVec(i), true)
    }

    const fakeEmbed = async (text: string): Promise<number[]> => {
      // Simulate ~1ms Ollama RTT for benchmarking purposes (real RTT is ~20-80ms)
      await new Promise(r => setTimeout(r, 1))
      return fakeVec(text.length)
    }

    const opts = { store, projectId, embedFn: fakeEmbed }
    const semanticSamples: number[] = []
    const recencySamples: number[] = []
    const sessionSamples: number[] = []

    // warm-up
    for (let i = 0; i < WARM; i++) {
      await retrieve('add retry logic to fetch', { ...opts, mode: 'semantic' })
      await retrieve('recent context', { ...opts, mode: 'recency' })
    }

    for (let i = 0; i < N; i++) {
      const t0 = performance.now()
      await retrieve('add retry logic with exponential backoff to charge function', { ...opts, mode: 'semantic' })
      semanticSamples.push(performance.now() - t0)

      const t1 = performance.now()
      await retrieve('what did we do recently', { ...opts, mode: 'recency' })
      recencySamples.push(performance.now() - t1)

      const t2 = performance.now()
      await retrieve('what are we working on', { ...opts, mode: 'session' })
      sessionSamples.push(performance.now() - t2)
    }

    return { semantic: semanticSamples, recency: recencySamples, session: sessionSamples }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n── MemWise p99 benchmark (N=${N}, warm=${WARM}) ──\n`)

  console.log('  [capture] running...')
  const captureSamples = benchCapture()

  console.log('  [retrieval] seeding 300 rows + running...')
  const { semantic, recency, session } = await benchRetrieve()

  console.log('\n── results ──────────────────────────────────────────────────────────────────────\n')
  stats('capture (persistMessage)', captureSamples)
  stats('retrieve: semantic', semantic)
  stats('retrieve: recency', recency)
  stats('retrieve: session', session)
  console.log()

  // Alert thresholds — capture should be sub-10ms, retrieval sub-50ms at p99.
  const capP99 = [...captureSamples].sort((a, b) => a - b)[Math.ceil(0.99 * captureSamples.length) - 1]!
  const retP99 = Math.max(
    [...semantic].sort((a, b) => a - b)[Math.ceil(0.99 * semantic.length) - 1]!,
    [...recency].sort((a, b) => a - b)[Math.ceil(0.99 * recency.length) - 1]!,
  )

  const capOk = capP99 < 10
  const retOk = retP99 < 50

  console.log(`  capture p99 ${capP99.toFixed(1)}ms  ${capOk ? '✓ (<10ms)' : '✗ (>10ms — check indexes / WAL mode)'}`)
  console.log(`  retrieval p99 ${retP99.toFixed(1)}ms  ${retOk ? '✓ (<50ms)' : '✗ (>50ms — check vec search / RRF)'}`)
  console.log()

  process.exit(capOk && retOk ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })

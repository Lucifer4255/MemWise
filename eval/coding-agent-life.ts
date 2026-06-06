/**
 * coding-agent-life-v1 retrieval eval for MemWise — on-domain, label-comparable to agentmemory.
 *
 * Reuses agentmemory's hand-labeled benchmark (15 coding sessions, 15 paraphrased queries with
 * goldSessionIds) so MemWise gets a real, paraphrase-based quality number — not the exact-text
 * known-item baseline run-eval.ts produces. Directly comparable to agentmemory's published row
 * (P@5 0.578, R@5 0.967, hit-rate 15/15, p50 14ms) in am/docs/benchmarks/2026-05-20-coding-agent-life-v1.md.
 *
 * These sessions are flat [user]/[assistant] narration (no tool calls), so we bypass the transcript
 * replay path and ingest each session as ONE context chunk with a real embedding, then score
 * retrieval at the SESSION level: a query "hits" if a chunk from a gold session ranks in top-K.
 *
 * Usage:
 *   npx tsx eval/coding-agent-life.ts [--data <dir>] [--mode semantic|recency] [--fast] [--verbose]
 *   --data   dir holding sessions.json + queries.json (default: ./am/eval/data/coding-agent-life-v1)
 *   --fast   deterministic embeddings (no Ollama) — disables the semantic signal; for plumbing only.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EMBED_DIM } from '../src/core/config.js'
import { openDatabase } from '../src/core/db.js'
import { defaultOllamaEmbed, type EmbedFn } from '../src/embed/ollama-client.js'
import { retrieve } from '../src/retrieval/retrieve.js'
import type { RetrieveMode } from '../src/retrieval/types.js'

interface Session { id: string; timestamp: string; content: string }
interface Query { id: string; question: string; answer: string; goldSessionIds: string[]; type: string }

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(`--${name}`)

const dataDir = arg('data') ?? join(process.cwd(), 'am', 'eval', 'data', 'coding-agent-life-v1')
const mode = (arg('mode') ?? 'semantic') as RetrieveMode
const fast = flag('fast')
const verbose = flag('verbose')

if (!existsSync(join(dataDir, 'sessions.json')) || !existsSync(join(dataDir, 'queries.json'))) {
  console.error(`error: sessions.json/queries.json not found in ${dataDir}`)
  console.error('point --data at agentmemory\'s eval/data/coding-agent-life-v1 dir.')
  process.exit(2)
}

function deterministicEmbed(text: string): Promise<number[]> {
  const h = createHash('sha256').update(text).digest()
  const vec = new Array<number>(EMBED_DIM)
  for (let i = 0; i < EMBED_DIM; i++) vec[i] = (h[i % h.length]! / 255) * 2 - 1
  return Promise.resolve(vec)
}
const embedFn: EmbedFn = fast ? deterministicEmbed : defaultOllamaEmbed

const sigOf = (sessionId: string) => createHash('sha256').update(sessionId).digest('hex')

// ── metrics ──────────────────────────────────────────────────────────────────
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)
function pct(arr: number[], p: number): number {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!
}

async function main(): Promise<void> {
  const sessions = JSON.parse(readFileSync(join(dataDir, 'sessions.json'), 'utf-8')) as Session[]
  const queries = JSON.parse(readFileSync(join(dataDir, 'queries.json'), 'utf-8')) as Query[]

  console.log(`\n── MemWise × coding-agent-life-v1 ──`)
  console.log(`  sessions: ${sessions.length}   queries: ${queries.length}`)
  console.log(`  embed:    ${fast ? 'deterministic (FAST — no semantic signal)' : 'ollama (real)'}   mode: ${mode}\n`)

  // 1. Ingest: one context chunk per session (real embedding), sig derived from session id.
  const { store } = openDatabase(':memory:')
  const projectId = 'coding-agent-life'
  const sigToSession = new Map<string, string>()
  process.stdout.write('  ingesting')
  for (const s of sessions) {
    const sig = sigOf(s.id)
    sigToSession.set(sig, s.id)
    const ts = Date.parse(s.timestamp) || Date.now()
    const firstUser = s.content.split('\n').find(l => l.startsWith('[user]'))?.slice(6).trim() ?? s.id
    store.insertPromptSig({
      sig, parentSig: null, promptText: firstUser, sessionId: s.id,
      source: 'claude-code', projectId, ts,
    })
    const embedding = await embedFn(s.content)
    store.insertContextChunk({ id: `${sig}:ctx`, sig, text: s.content, projectId, ts, enriched: false }, embedding)
    process.stdout.write('.')
  }
  console.log(` done\n`)

  // 2. Score each query at the session level.
  const rows: { id: string; type: string; hit: boolean; rr: number; r5: number; p5: number; ms: number; topGold: boolean }[] = []
  for (const q of queries) {
    const gold = new Set(q.goldSessionIds)
    const res = await retrieve(q.question, { projectId, store, embedFn, mode, hybridLimit: 10 })
    // ranked sessions (dedup, preserve order)
    const rankedSessions: string[] = []
    for (const a of res.anchors) {
      const sid = sigToSession.get(a.sig)
      if (sid && !rankedSessions.includes(sid)) rankedSessions.push(sid)
    }
    const top5 = rankedSessions.slice(0, 5)
    const goldInTop5 = top5.filter(s => gold.has(s)).length
    let rr = 0
    for (let i = 0; i < rankedSessions.length; i++) if (gold.has(rankedSessions[i]!)) { rr = 1 / (i + 1); break }
    rows.push({
      id: q.id, type: q.type,
      hit: goldInTop5 > 0,
      rr,
      r5: gold.size ? goldInTop5 / gold.size : 0,
      p5: goldInTop5 / 5,
      ms: res.timingMs,
      topGold: rankedSessions[0] ? gold.has(rankedSessions[0]) : false,
    })
  }

  if (verbose) {
    console.log('  per-query:')
    for (const r of rows) {
      const q = queries.find(x => x.id === r.id)!
      console.log(`    ${r.hit ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${r.id} ${q.question.slice(0, 46).padEnd(46)} RR=${r.rr.toFixed(2)} top1=${r.topGold ? 'gold' : '—'}`)
    }
    console.log('')
  }

  const hitRate = rows.filter(r => r.hit).length / rows.length
  console.log('── MemWise results ──────────────────────────────────────')
  console.log(`  Recall@5:    ${mean(rows.map(r => r.r5)).toFixed(3)}`)
  console.log(`  Precision@5: ${mean(rows.map(r => r.p5)).toFixed(3)}   (1 gold/query → max 0.20; granularity-sensitive)`)
  console.log(`  MRR:         ${mean(rows.map(r => r.rr)).toFixed(3)}`)
  console.log(`  Hit-rate@5:  ${hitRate.toFixed(3)}  (${rows.filter(r => r.hit).length}/${rows.length})`)
  console.log(`  Top-1 gold:  ${(rows.filter(r => r.topGold).length / rows.length).toFixed(3)}`)
  console.log(`  latency:     p50 ${pct(rows.map(r => r.ms), 50).toFixed(1)}ms   p95 ${pct(rows.map(r => r.ms), 95).toFixed(1)}ms`)
  console.log('')
  console.log('── agentmemory published (same dataset) ─────────────────')
  console.log('  hybrid:  P@5 0.578   R@5 0.967   hit 15/15   p50 14ms')
  console.log('  grep:    P@5 0.267   R@5 0.967   hit 15/15   p50  0ms')
  console.log('  (P@5 differs by retrieval granularity — compare Recall@5 / Hit-rate / MRR.)\n')
}

main().catch(err => { console.error(err); process.exit(1) })

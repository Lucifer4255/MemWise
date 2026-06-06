/**
 * Lightweight retrieval-quality eval for MemWise (pre-M2 baseline).
 *
 * Ingests a project's real Claude Code transcripts into a throwaway DB via the live capture path,
 * then runs a set of labeled queries through retrieve() and scores Recall@K / Precision@K / MRR.
 * Coding-relevant by construction (real sessions, real code edits) — unlike LongMemEval, which is
 * generic conversational QA. See the discussion in the M2 planning thread.
 *
 * Usage:
 *   npx tsx eval/run-eval.ts --project <dirname|path> [--labels <file>] [--bootstrap]
 *                            [--mode semantic|recency|session] [--fast] [--verbose]
 *
 *   --project    A ~/.claude/projects/<dir> name, or an absolute path to a dir of *.jsonl. Required.
 *   --labels     JSON file: [{ "query": "...", "relevant": ["sig", ...] }]. The real eval input.
 *   --bootstrap  No labels yet? Auto-generate known-item labels (query=prompt → relevant=[its sig])
 *                and write them to eval/labels.<project>.json for you to curate. This is a TRIVIAL
 *                baseline (exact-text match); replace with hand-picked relevance for a real signal.
 *   --mode       retrieve() mode (default: semantic).
 *   --fast       Deterministic hash embeddings (no Ollama). Disables the semantic/vector signal —
 *                only FTS keyword + graph expansion are exercised. Use real embeddings for a true
 *                semantic eval (the default).
 *   --verbose    Print per-query results.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { EMBED_DIM } from '../src/core/config.js'
import { defaultOllamaEmbed, type EmbedFn } from '../src/embed/ollama-client.js'
import { replayTranscript } from '../src/replay/replay.js'
import { retrieve } from '../src/retrieval/retrieve.js'
import type { SqliteStore } from '../src/store/sqlite-store.js'
import type { RetrieveMode } from '../src/retrieval/types.js'

// ── args ──────────────────────────────────────────────────────────────────────
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

const projectArg = arg('project')
const labelsPath = arg('labels')
const bootstrap = flag('bootstrap')
const mode = (arg('mode') ?? 'semantic') as RetrieveMode
const fast = flag('fast')
const verbose = flag('verbose')

if (!projectArg) {
  console.error('error: --project <dirname|path> is required (a ~/.claude/projects/<dir> name or an absolute dir).')
  process.exit(2)
}

// Resolve the project transcript dir.
const projectDir = isAbsolute(projectArg)
  ? projectArg
  : join(homedir(), '.claude', 'projects', projectArg)

if (!existsSync(projectDir)) {
  console.error(`error: project dir not found: ${projectDir}`)
  process.exit(2)
}

const transcripts = readdirSync(projectDir)
  .filter(f => f.endsWith('.jsonl'))
  .map(f => join(projectDir, f))

if (transcripts.length === 0) {
  console.error(`error: no *.jsonl transcripts in ${projectDir}`)
  console.error('(A project whose raw transcripts were deleted keeps only sessions-index.json — nothing to replay.)')
  process.exit(2)
}

// ── embeddings ──────────────────────────────────────────────────────────────────
function deterministicEmbed(text: string): Promise<number[]> {
  const h = createHash('sha256').update(text).digest()
  const vec = new Array<number>(EMBED_DIM)
  for (let i = 0; i < EMBED_DIM; i++) vec[i] = (h[i % h.length]! / 255) * 2 - 1
  return Promise.resolve(vec)
}
// Ingest and query MUST share an embed fn (same vector space) or semantic ranking is noise.
const embedFn: EmbedFn = fast ? deterministicEmbed : defaultOllamaEmbed

// ── metrics ─────────────────────────────────────────────────────────────────────
interface Label { query: string; relevant: string[] }
interface QueryScore { query: string; rr: number; r5: number; r10: number; p5: number; ms: number; topSig: string }

function recallAt(ranked: string[], relevant: Set<string>, k: number): number {
  const hits = ranked.slice(0, k).filter(s => relevant.has(s)).length
  return relevant.size === 0 ? 0 : hits / relevant.size
}
function precisionAt(ranked: string[], relevant: Set<string>, k: number): number {
  const hits = ranked.slice(0, k).filter(s => relevant.has(s)).length
  return hits / k
}
function reciprocalRank(ranked: string[], relevant: Set<string>): number {
  for (let i = 0; i < ranked.length; i++) if (relevant.has(ranked[i]!)) return 1 / (i + 1)
  return 0
}
function pct(arr: number[], p: number): number {
  if (!arr.length) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
}
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)

// ── main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`\n── MemWise retrieval eval ──`)
  console.log(`  project:     ${projectDir}`)
  console.log(`  transcripts: ${transcripts.length}`)
  console.log(`  embed:       ${fast ? 'deterministic (FAST — no semantic signal)' : 'ollama (real)'}`)
  console.log(`  mode:        ${mode}\n`)

  // 1. Ingest every transcript into one shared throwaway DB (same file → rows accumulate).
  const dbPath = join(mkdtempSync(join(tmpdir(), 'memwise-eval-')), 'eval.db')
  let store: SqliteStore | undefined
  let projectId = ''
  let totalChunks = 0
  process.stdout.write('  ingesting')
  for (const t of transcripts) {
    const r = await replayTranscript(t, { dbPath, embedFn })
    store = r.store
    projectId = r.projectId
    totalChunks += r.counts.contextChunk
    process.stdout.write('.')
  }
  console.log(` done — ${totalChunks} chunks, projectId=${projectId}\n`)
  if (!store) { console.error('no store'); process.exit(1) }

  // 2. Labels — load, or bootstrap known-item labels from captured prompts.
  let labels: Label[]
  if (labelsPath) {
    labels = JSON.parse(readFileSync(labelsPath, 'utf-8')) as Label[]
    console.log(`  labels:      ${labels.length} from ${labelsPath}\n`)
  } else if (bootstrap) {
    const msgs = store.queryRecentMessagesScoped(projectId, 1000)
    labels = msgs.map(m => ({ query: m.promptText, relevant: [m.sig] }))
    const out = join('eval', `labels.${projectArg!.replace(/[^a-zA-Z0-9]/g, '-')}.json`)
    writeFileSync(out, JSON.stringify(labels, null, 2))
    console.log(`  labels:      ${labels.length} auto-generated (known-item) → wrote ${out}`)
    console.log(`               ⚠ TRIVIAL baseline (exact-text). Curate this file for a real signal.\n`)
  } else {
    console.error('error: provide --labels <file> or --bootstrap to generate a starter set.')
    process.exit(2)
  }
  if (!labels.length) { console.error('no labels'); process.exit(1) }

  // 3. Score each query.
  const scores: QueryScore[] = []
  for (const lab of labels) {
    const relevant = new Set(lab.relevant)
    const res = await retrieve(lab.query, { projectId, store, embedFn, mode })
    const ranked = res.anchors.map(a => a.sig)
    scores.push({
      query: lab.query,
      rr: reciprocalRank(ranked, relevant),
      r5: recallAt(ranked, relevant, 5),
      r10: recallAt(ranked, relevant, 10),
      p5: precisionAt(ranked, relevant, 5),
      ms: res.timingMs,
      topSig: ranked[0]?.slice(0, 8) ?? '—',
    })
  }

  // 4. Report.
  if (verbose) {
    console.log('  per-query:')
    for (const s of scores) {
      const q = s.query.replace(/\s+/g, ' ').slice(0, 54).padEnd(54)
      console.log(`    ${s.rr > 0 ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${q} RR=${s.rr.toFixed(2)} R@5=${s.r5.toFixed(2)} top=${s.topSig}`)
    }
    console.log('')
  }

  const hitRate = scores.filter(s => s.r5 > 0).length / scores.length
  console.log('── results ──────────────────────────────────────────────')
  console.log(`  queries:       ${scores.length}`)
  console.log(`  Recall@5:      ${mean(scores.map(s => s.r5)).toFixed(3)}`)
  console.log(`  Recall@10:     ${mean(scores.map(s => s.r10)).toFixed(3)}`)
  console.log(`  Precision@5:   ${mean(scores.map(s => s.p5)).toFixed(3)}`)
  console.log(`  MRR:           ${mean(scores.map(s => s.rr)).toFixed(3)}`)
  console.log(`  Hit-rate@5:    ${hitRate.toFixed(3)}  (${scores.filter(s => s.r5 > 0).length}/${scores.length})`)
  console.log(`  latency p50:   ${pct(scores.map(s => s.ms), 50).toFixed(1)}ms   p95: ${pct(scores.map(s => s.ms), 95).toFixed(1)}ms`)
  console.log('')
}

main().catch(err => { console.error(err); process.exit(1) })

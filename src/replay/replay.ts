import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { parseClaudeCodeHook } from '../adapters/claude-code.js'
import { EMBED_DIM } from '../config.js'
import { openDatabase } from '../db.js'
import { Embedder } from '../embed/embedder.js'
import type { EmbedFn } from '../embed/ollama-client.js'
import { defaultOllamaEmbed } from '../embed/ollama-client.js'
import { Flusher } from '../flush/flusher.js'
import { CapturePipeline } from '../pipeline/pipeline.js'
import { projectIdFromPath } from '../project.js'
import { closeRedis, type Redis } from '../redis.js'
import { retrieve } from '../retrieval/retrieve.js'
import type { SqliteStore } from '../store/sqlite-store.js'
import { readTranscript } from './transcript-reader.js'

/**
 * Offline, deterministic embedding — no network. Replaying a whole transcript fires an embed per
 * turn; routing that at a local Ollama overruns its pending-request cap (503). The harness only
 * needs to validate the capture→flush→retrieve plumbing, so it embeds deterministically by default.
 * Set MEMWISE_REPLAY_EMBED=ollama to use real embeddings (slower; semantic ranking becomes real).
 */
function deterministicEmbed(text: string): Promise<number[]> {
  const h = createHash('sha256').update(text).digest()
  const vec = new Array<number>(EMBED_DIM)
  for (let i = 0; i < EMBED_DIM; i++) vec[i] = (h[i % h.length]! / 255) * 2 - 1
  return Promise.resolve(vec)
}

function embedFnForMode(): EmbedFn {
  return process.env.MEMWISE_REPLAY_EMBED === 'ollama' ? defaultOllamaEmbed : deterministicEmbed
}

/**
 * Replay harness — drive a real Claude Code transcript through the live capture path
 * (transcript → hook payloads → parseClaudeCodeHook → pipeline → flush → SQLite) so the whole
 * L2–L6 stack can be exercised on real data without wiring live hooks. Requires Redis (the hot
 * window) and, unless a mock embedder is passed, Ollama (embeddings).
 */

export interface ReplayOptions {
  dbPath?: string
  embedder?: Embedder
  redis?: Redis
}

export interface ReplaySummary {
  store: SqliteStore
  db: Database.Database
  sessionId: string
  projectId: string
  events: number
  turnsFinalized: number
  counts: { promptSig: number; change: number; symbolDep: number; contextChunk: number }
}

export async function replayTranscript(path: string, opts: ReplayOptions = {}): Promise<ReplaySummary> {
  const { events, sessionId, projectPath } = readTranscript(path)
  const { db, store } = openDatabase(opts.dbPath ?? ':memory:')
  const embedder = opts.embedder ?? new Embedder(embedFnForMode(), opts.redis)
  const flusher = new Flusher(store, embedder)
  const pipeline = new CapturePipeline(undefined, undefined, { store, embedder, flusher })

  // Isolate each replay in its own Redis namespace: reusing the transcript's real sessionId would
  // collide with prior runs (dedup keys suppress finalization; leftover hot chunks get flushed).
  const runSession = `${sessionId}:replay${Date.now()}`

  let turnsFinalized = 0
  let seq = 1
  for (const { payload, ts } of events) {
    const ev = parseClaudeCodeHook(payload, { seq: seq++ })
    if (!ev) continue // unknown hook or non-final narration delta
    ev.sessionId = runSession
    ev.ts = ts // transcript time, not Date.now() — keeps recency ordering faithful
    const result = await pipeline.process(ev)
    if (result.finalized) turnsFinalized++
  }

  await flusher.flushSession(runSession)

  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

  return {
    store,
    db,
    sessionId,
    projectId: projectIdFromPath(projectPath),
    events: events.length,
    turnsFinalized,
    counts: {
      promptSig: count('prompt_sig'),
      change: count('change'),
      symbolDep: count('symbol_dep'),
      contextChunk: count('context_chunk'),
    },
  }
}

const isEntry =
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('replay.ts') || process.argv[1].endsWith('replay.js'))

if (isEntry) {
  const path = process.argv[2]
  const query = process.argv.slice(3).join(' ') || 'get the context of what we are working on'
  if (!path) {
    console.error('usage: npx tsx src/replay/replay.ts <transcript.jsonl> [query]')
    process.exit(1)
  }
  replayTranscript(path)
    .then(async r => {
      console.log('\n── memwise replay ──\n')
      console.log(`  session    ${r.sessionId}`)
      console.log(`  project    ${r.projectId}`)
      console.log(`  events     ${r.events} hook payloads`)
      console.log(`  turns      ${r.turnsFinalized} finalized messages`)
      console.log(
        `  SQLite     ${r.counts.promptSig} prompt_sig · ${r.counts.change} change · ` +
          `${r.counts.symbolDep} symbol_dep · ${r.counts.contextChunk} context_chunk`,
      )
      console.log(`\n── query: "${query}" ──\n`)
      // Query must embed with the SAME fn used at write time so vector ranking is comparable.
      const result = await retrieve(query, {
        store: r.store,
        projectId: r.projectId,
        skipHot: true,
        embedFn: embedFnForMode(),
      })
      console.log(result.block)
      console.log(`\n  (${result.tokenCount} tokens, ${result.timingMs.toFixed(1)}ms)\n`)
      r.db.close()
      await closeRedis()
      process.exit(0)
    })
    .catch(async err => {
      console.error(err)
      await closeRedis().catch(() => {})
      process.exit(1)
    })
}

import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { captureFromTranscript } from '../capture/turn-capture.js'
import { EMBED_DIM } from '../config.js'
import { openDatabase } from '../db.js'
import type { EmbedFn } from '../embed/ollama-client.js'
import { defaultOllamaEmbed } from '../embed/ollama-client.js'
import { projectIdFromPath } from '../project.js'
import { retrieve } from '../retrieval/retrieve.js'
import type { SqliteStore } from '../store/sqlite-store.js'
import { readTranscript } from './transcript-reader.js'

/**
 * Offline, deterministic embedding — no network. Replaying a whole transcript fires an embed per
 * turn; routing that at a local Ollama overruns its pending-request cap (503). The harness only
 * needs to validate the capture→retrieve plumbing, so it embeds deterministically by default.
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
 * (transcript → captureFromTranscript → SQLite) so the L2/L4/L8 capture stack can be exercised on
 * real data without wiring live hooks. No Redis. Enrichment is left disabled unless a chat model is
 * present (set MEMWISE_ENRICH_ENABLED=off to force-skip).
 */
export interface ReplayOptions {
  dbPath?: string
  embedFn?: EmbedFn
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
  const { db, store } = openDatabase(opts.dbPath ?? ':memory:')
  const { events } = readTranscript(path)

  const result = await captureFromTranscript(path, {
    store,
    embedFn: opts.embedFn ?? embedFnForMode(),
    skipConsolidate: true,
  })

  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

  return {
    store,
    db,
    sessionId: result.sessionId,
    projectId: result.projectId,
    events: events.length,
    turnsFinalized: result.captured,
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
  void projectIdFromPath // (kept import side-effect-free)
  replayTranscript(path)
    .then(async r => {
      console.log('\n── memwise replay ──\n')
      console.log(`  session    ${r.sessionId}`)
      console.log(`  project    ${r.projectId}`)
      console.log(`  events     ${r.events} hook payloads`)
      console.log(`  turns      ${r.turnsFinalized} captured messages`)
      console.log(
        `  SQLite     ${r.counts.promptSig} prompt_sig · ${r.counts.change} change · ` +
          `${r.counts.symbolDep} symbol_dep · ${r.counts.contextChunk} context_chunk`,
      )
      console.log(`\n── query: "${query}" ──\n`)
      const result = await retrieve(query, {
        store: r.store,
        projectId: r.projectId,
        embedFn: embedFnForMode(),
      })
      console.log(result.block)
      console.log(`\n  (${result.tokenCount} tokens, ${result.timingMs.toFixed(1)}ms)\n`)
      r.db.close()
      process.exit(0)
    })
    .catch(err => {
      console.error(err)
      process.exit(1)
    })
}

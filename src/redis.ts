import { createHash } from 'node:crypto'
import { Redis } from 'ioredis'
import {
  CHUNK_TOKENS_EST,
  EMBED_DIM,
  HOT_WINDOW_MAX_TOKENS,
  HOT_WINDOW_TTL_S,
} from './config.js'

export type { Redis }

export const CHUNK_PREFIX = 'mw:chunk:'
export const HOT_ZSET_PREFIX = 'mw:hot:'
export const HOT_TOKENS_PREFIX = 'mw:hot:tokens:'
export const SEARCH_INDEX = 'mw:idx'

let client: Redis | null = null

export function getRedis(): Redis {
  if (!client) {
    client = new Redis({
      host: process.env.MEMWISE_REDIS_HOST ?? '127.0.0.1',
      port: Number(process.env.MEMWISE_REDIS_PORT ?? 6379),
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    })
  }
  return client
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit()
    client = null
  }
}

export function chunkKey(sessionId: string, seq: number): string {
  return `${CHUNK_PREFIX}${sessionId}:${seq}`
}

export function hotZsetKey(sessionId: string): string {
  return `${HOT_ZSET_PREFIX}${sessionId}`
}

export function hotTokensKey(sessionId: string): string {
  return `${HOT_TOKENS_PREFIX}${sessionId}`
}

/** Cheap token estimate (~4 chars/token). Used for the token-budgeted window. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

export async function ensureSearchIndex(redis: Redis = getRedis()): Promise<void> {
  try {
    await redis.call('FT.INFO', SEARCH_INDEX)
    return
  } catch {
    // index missing — create below
  }

  await redis.call(
    'FT.CREATE',
    SEARCH_INDEX,
    'ON',
    'HASH',
    'PREFIX',
    '1',
    CHUNK_PREFIX,
    'SCHEMA',
    'text',
    'TEXT',
    'session',
    'TAG',
    'project',
    'TAG',
    'ts',
    'NUMERIC',
    'embedded',
    'NUMERIC',
    'embedding',
    'VECTOR',
    // FLAT (not HNSW): the hot window is small (≤~6k vectors @1M tokens), so brute-force
    // is exact, sub-3ms, and carries no graph RAM. Switch to HNSW only past ~5M tokens.
    'FLAT',
    '6',
    'TYPE',
    'FLOAT32',
    'DIM',
    String(EMBED_DIM),
    'DISTANCE_METRIC',
    'COSINE',
  )
}

export interface HotChunkInput {
  sessionId: string
  projectId: string
  seq: number
  text: string
  sig?: string
  ts: number
  // Spine payload — present at TURN_END, absent for bare hot-window pushes (tests/generic callers).
  finalized?: {
    promptText: string
    parentSig: string | null
    source: string
    tsOpen: number
    changesJson: string
    depsJson: string
  }
}

/** Called for each chunk BEFORE it is deleted on eviction — the flush-then-delete seam.
 *  Layer 5 injects the SQLite flush here; until then eviction drops (pre-flusher). */
export type EvictHook = (sessionId: string, seq: number) => Promise<void> | void

export interface HotWindowOpts {
  redis?: Redis
  maxTokens?: number
  onEvict?: EvictHook
}

export async function pushHotChunk(input: HotChunkInput, opts: HotWindowOpts = {}): Promise<string> {
  const redis = opts.redis ?? getRedis()
  const key = chunkKey(input.sessionId, input.seq)
  const tokens = estimateTokens(input.text)
  const zkey = hotZsetKey(input.sessionId)
  const tkey = hotTokensKey(input.sessionId)

  const hashFields: Record<string, string> = {
    text: input.text,
    sig: input.sig ?? '',
    session: input.sessionId,
    project: input.projectId,
    ts: String(input.ts),
    embedded: '0',
    tokens: String(tokens),
    ...(input.finalized
      ? {
          prompt_text: input.finalized.promptText,
          parent_sig: input.finalized.parentSig ?? '',
          source: input.finalized.source,
          ts_open: String(input.finalized.tsOpen),
          changes_json: input.finalized.changesJson,
          deps_json: input.finalized.depsJson,
        }
      : {}),
  }

  // Atomic: all fields + recency ZSET + token counter land together (or not at all).
  await redis
    .multi()
    .hset(key, hashFields)
    .expire(key, HOT_WINDOW_TTL_S)
    .zadd(zkey, input.ts, String(input.seq))
    .expire(zkey, HOT_WINDOW_TTL_S)
    .incrby(tkey, tokens)
    .expire(tkey, HOT_WINDOW_TTL_S)
    .exec()

  await trimHotWindow(input.sessionId, opts)
  return key
}

/** Evict oldest chunks until the session's token sum is within budget.
 *  FLUSH-THEN-DELETE: onEvict runs before the hash is removed, so no un-flushed chunk is lost. */
export async function trimHotWindow(sessionId: string, opts: HotWindowOpts = {}): Promise<void> {
  const redis = opts.redis ?? getRedis()
  const maxTokens = opts.maxTokens ?? HOT_WINDOW_MAX_TOKENS
  const zkey = hotZsetKey(sessionId)
  const tkey = hotTokensKey(sessionId)

  let total = Number((await redis.get(tkey)) ?? 0)

  while (total > maxTokens) {
    const oldest = await redis.zrange(zkey, 0, 0)
    if (oldest.length === 0) break
    const seq = oldest[0]!
    const ckey = chunkKey(sessionId, Number(seq))
    const chunkTokens = Number((await redis.hget(ckey, 'tokens')) ?? CHUNK_TOKENS_EST)

    if (opts.onEvict) await opts.onEvict(sessionId, Number(seq)) // flush before delete

    await redis.multi().del(ckey).zrem(zkey, seq).decrby(tkey, chunkTokens).exec()
    total -= chunkTokens
  }
}

/** Write embedding in place — text/sig/session fields unchanged; enables hot KNN. */
export async function writeChunkEmbedding(
  sessionId: string,
  seq: number,
  embedding: Buffer,
  redis: Redis = getRedis(),
): Promise<void> {
  await redis.hset(chunkKey(sessionId, seq), {
    embedding,
    embedded: '1',
  })
}

export type HotChunkRecord = Record<string, string>

export async function readHotChunk(
  sessionId: string,
  seq: number,
  redis: Redis = getRedis(),
): Promise<HotChunkRecord | null> {
  const data = await redis.hgetall(chunkKey(sessionId, seq))
  if (!data || Object.keys(data).length === 0) return null
  return data
}

/**
 * Read the binary `embedding` field as a Buffer. MUST NOT go through hgetall/hgetall-style
 * reads: those UTF-8-decode every value, which mangles the raw Float32 bytes (non-ASCII bytes
 * become U+FFFD and the length stops being 4·DIM). hgetBuffer preserves the bytes verbatim.
 */
export async function readChunkEmbedding(
  sessionId: string,
  seq: number,
  redis: Redis = getRedis(),
): Promise<Buffer | null> {
  const buf = await redis.hgetBuffer(chunkKey(sessionId, seq), 'embedding')
  return buf && buf.length > 0 ? buf : null
}

/** List session ids with a hot-window ZSET (excludes token-counter keys). */
export async function listHotSessionIds(redis: Redis = getRedis()): Promise<string[]> {
  const ids: string[] = []
  let cursor = '0'
  do {
    const [next, keys] = (await redis.scan(
      cursor,
      'MATCH',
      `${HOT_ZSET_PREFIX}*`,
      'COUNT',
      100,
    )) as [string, string[]]
    cursor = next
    for (const key of keys) {
      if (key.startsWith(HOT_TOKENS_PREFIX)) continue
      ids.push(key.slice(HOT_ZSET_PREFIX.length))
    }
  } while (cursor !== '0')
  return ids
}

/** Latest activity timestamp (ms) for a session's hot window, or null if empty. */
export async function sessionLastActivityTs(
  sessionId: string,
  redis: Redis = getRedis(),
): Promise<number | null> {
  const result = await redis.zrevrange(hotZsetKey(sessionId), 0, 0, 'WITHSCORES')
  if (result.length < 2) return null
  return Number(result[1])
}

/** All chunk seqs in a session, oldest first. */
export async function listHotChunkSeqs(
  sessionId: string,
  redis: Redis = getRedis(),
): Promise<number[]> {
  const members = await redis.zrange(hotZsetKey(sessionId), 0, -1)
  return members.map(s => Number(s)).filter(n => !Number.isNaN(n))
}

/** Remove one chunk from the hot window (after SQLite flush). */
export async function deleteHotChunk(
  sessionId: string,
  seq: number,
  redis: Redis = getRedis(),
): Promise<void> {
  const ckey = chunkKey(sessionId, seq)
  const chunkTokens = Number((await redis.hget(ckey, 'tokens')) ?? CHUNK_TOKENS_EST)
  await redis
    .multi()
    .del(ckey)
    .zrem(hotZsetKey(sessionId), String(seq))
    .decrby(hotTokensKey(sessionId), chunkTokens)
    .exec()
}

/** Stable hash for dedup SET (exclude volatile seq/ts). */
export function hashCaptureEvent(event: Record<string, unknown>): string {
  const copy = { ...event }
  delete copy.seq
  delete copy.ts
  return createHash('sha256').update(JSON.stringify(copy)).digest('hex')
}

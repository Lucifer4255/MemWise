import { createHash } from 'node:crypto'
import { Redis } from 'ioredis'
import {
  CHUNK_TOKENS_EST,
  EMBED_DIM,
  HOT_WINDOW_MAX_TOKENS,
  HOT_WINDOW_TTL_S,
} from './config.js'

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

  // Atomic: hash + recency ZSET + token counter all land together (or not at all).
  await redis
    .multi()
    .hset(key, {
      text: input.text,
      sig: input.sig ?? '',
      session: input.sessionId,
      project: input.projectId,
      ts: String(input.ts),
      embedded: '0',
      tokens: String(tokens), // not in the FT schema — used for DECRBY on evict
    })
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

export async function updateChunkSig(
  sessionId: string,
  seq: number,
  sig: string,
  redis: Redis = getRedis(),
): Promise<void> {
  await redis.hset(chunkKey(sessionId, seq), 'sig', sig)
}

/** Stable hash for dedup SET (exclude volatile seq/ts). */
export function hashCaptureEvent(event: Record<string, unknown>): string {
  const copy = { ...event }
  delete copy.seq
  delete copy.ts
  return createHash('sha256').update(JSON.stringify(copy)).digest('hex')
}

import { EMBED_DIM, RETRIEVE_HYBRID_LIMIT } from '../config.js'
import { embeddingToBuffer } from '../embed/vector.js'
import {
  ensureSearchIndex,
  getRedis,
  SEARCH_INDEX,
  type Redis,
} from '../redis.js'
import { fuseRankedLists } from '../rrf.js'
import type { MemoryStore } from '../store/memory-store.js'
import type { AnchorHit, RetrieveOptions } from './types.js'

type HotResult = { sigs: string[]; meta: Map<string, { text: string; ts: number }> }
const EMPTY_HOT: HotResult = { sigs: [], meta: new Map() }

export interface SearchAnchorsOpts {
  projectId: string
  query: string
  embedding: number[]
  store: MemoryStore
  redis?: Redis
  sessionId?: string
  limit?: number
  skipHot?: boolean
}

/** Escape a value for RediSearch TAG field `{...}` (hyphen splits tokens in queries). */
export function escapeTagValue(value: string): string {
  return value.replace(/([,.<>{}[\]"\\':;!?@#$%^&*()\-=+|~`\/])/g, '\\$&')
}

function parseFtSearch(result: unknown[]): { key: string; fields: Record<string, string> }[] {
  const docs: { key: string; fields: Record<string, string> }[] = []
  let i = 1
  while (i < result.length) {
    const key = String(result[i++] ?? '')
    const next = result[i]
    if (Array.isArray(next)) {
      const fields: Record<string, string> = {}
      for (let j = 0; j < next.length; j += 2) {
        const name = String(next[j] ?? '')
        const val = next[j + 1]
        fields[name] =
          typeof val === 'string'
            ? val
            : val instanceof Buffer
              ? val.toString('utf8')
              : String(val ?? '')
      }
      docs.push({ key, fields })
      i++
      continue
    }
    const nFields = Number(next ?? 0)
    i++
    const fields: Record<string, string> = {}
    for (let f = 0; f < nFields; f++) {
      const name = String(result[i++] ?? '')
      const val = result[i++]
      fields[name] =
        typeof val === 'string'
          ? val
          : val instanceof Buffer
            ? val.toString('utf8')
            : String(val ?? '')
    }
    docs.push({ key, fields })
  }
  return docs
}

async function hotMetaFromDocs(
  redis: Redis,
  docs: { key: string; fields: Record<string, string> }[],
): Promise<HotResult> {
  const sigs: string[] = []
  const meta = new Map<string, { text: string; ts: number }>()
  for (const doc of docs) {
    const sig = (doc.fields.sig ?? (await redis.hget(doc.key, 'sig')))?.trim()
    if (!sig) continue
    sigs.push(sig)
    const text = doc.fields.text ?? (await redis.hget(doc.key, 'text')) ?? ''
    const ts = Number(doc.fields.ts ?? (await redis.hget(doc.key, 'ts')) ?? 0)
    if (text) meta.set(sig, { text, ts })
  }
  return { sigs, meta }
}

/** RediSearch TEXT tokens: drop short words, cap at 8. Each token is escaped at query-build
 *  time; the ` | ` OR separator between them is added AFTER escaping so it stays an operator. */
function keywordsForTextSearch(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .filter(t => t.length > 2)
    .slice(0, 8)
}

/** Escape RediSearch special chars WITHIN a single token (never the OR separator). */
function escapeTextToken(token: string): string {
  return token.replace(/[@\-{}|()]/g, '\\$&')
}

async function hotKnn(
  redis: Redis,
  projectId: string,
  embedding: number[],
  limit: number,
  sessionId?: string,
): Promise<HotResult> {
  // KNN needs a full-width vector; an empty/short embedding (embed failure → []) would otherwise
  // be zero-padded and return garbage neighbours. Skip hot-KNN and let text/cold carry recall.
  if (embedding.length !== EMBED_DIM) return EMPTY_HOT
  const projectTag = escapeTagValue(projectId)
  const sessionFilter = sessionId ? ` @session:{${escapeTagValue(sessionId)}}` : ''
  const query = `(@project:{${projectTag}}${sessionFilter} @embedded:[1 1])=>[KNN ${limit} @embedding $vec AS dist]`
  try {
    const raw = (await redis.call(
      'FT.SEARCH',
      SEARCH_INDEX,
      query,
      'PARAMS',
      '2',
      'vec',
      embeddingToBuffer(embedding),
      'SORTBY',
      'dist',
      'ASC',
      'DIALECT',
      '2',
      'LIMIT',
      '0',
      String(limit),
    )) as unknown[]
    const docs = parseFtSearch(raw)
    return hotMetaFromDocs(redis, docs)
  } catch {
    return EMPTY_HOT
  }
}

async function hotText(
  redis: Redis,
  projectId: string,
  keywords: string,
  limit: number,
  sessionId?: string,
): Promise<HotResult> {
  const tokens = keywordsForTextSearch(keywords)
  if (tokens.length === 0) return EMPTY_HOT
  const projectTag = escapeTagValue(projectId)
  const sessionFilter = sessionId ? ` @session:{${escapeTagValue(sessionId)}}` : ''
  const orClause = tokens.map(escapeTextToken).join(' | ')
  const query = `@project:{${projectTag}}${sessionFilter} @text:(${orClause})`
  try {
    const raw = (await redis.call(
      'FT.SEARCH',
      SEARCH_INDEX,
      query,
      'LIMIT',
      '0',
      String(limit),
    )) as unknown[]
    const docs = parseFtSearch(raw)
    return hotMetaFromDocs(redis, docs)
  } catch {
    return EMPTY_HOT
  }
}

export async function searchAnchors(opts: SearchAnchorsOpts): Promise<AnchorHit[]> {
  const limit = opts.limit ?? RETRIEVE_HYBRID_LIMIT
  const lists: { sigs: string[]; source: string }[] = []
  const hotMeta = new Map<string, { text: string; ts: number }>()

  if (!opts.skipHot) {
    const redis = opts.redis ?? getRedis()
    await ensureSearchIndex(redis)
    const [knn, text] = await Promise.all([
      hotKnn(redis, opts.projectId, opts.embedding, limit, opts.sessionId),
      hotText(redis, opts.projectId, opts.query, limit, opts.sessionId),
    ])
    for (const m of [knn.meta, text.meta]) {
      for (const [sig, v] of m) hotMeta.set(sig, v)
    }
    if (knn.sigs.length) lists.push({ sigs: knn.sigs, source: 'hot-knn' })
    if (text.sigs.length) lists.push({ sigs: text.sigs, source: 'hot-text' })
  }

  const cold = opts.store.queryHybridScoped(
    opts.projectId,
    opts.embedding,
    opts.query,
    limit,
  )
  if (cold.length) {
    lists.push({ sigs: cold.map(c => c.sig), source: 'cold' })
  }

  const sourceLists = lists.map(l => l.sigs)
  const fusedSigs = fuseRankedLists(sourceLists, limit)

  const sourceBySig = new Map<string, Set<string>>()
  for (const { sigs, source } of lists) {
    for (const sig of sigs) {
      if (!sig) continue
      const set = sourceBySig.get(sig) ?? new Set()
      set.add(source)
      sourceBySig.set(sig, set)
    }
  }

  const hits: AnchorHit[] = []
  for (const sig of fusedSigs) {
    const chunk = opts.store.getContextChunkBySig(sig)
    const hot = hotMeta.get(sig)
    const text = chunk?.text ?? hot?.text ?? ''
    const ts = chunk?.ts ?? hot?.ts ?? 0
    hits.push({
      sig,
      text,
      ts,
      sources: [...(sourceBySig.get(sig) ?? [])],
    })
  }
  return hits
}

export async function searchRecentAnchors(
  store: MemoryStore,
  projectId: string,
  limit: number,
): Promise<AnchorHit[]> {
  const chunks = store.queryRecentChunks(projectId, limit)
  return chunks.map(c => ({
    sig: c.sig,
    text: c.text,
    ts: c.ts,
    sources: ['recency'],
  }))
}

export function searchAnchorsFromOpts(
  opts: RetrieveOptions & { projectId: string; query: string; embedding: number[]; store: MemoryStore },
): Promise<AnchorHit[]> {
  return searchAnchors({
    projectId: opts.projectId,
    query: opts.query,
    embedding: opts.embedding,
    store: opts.store,
    redis: opts.redis,
    sessionId: opts.sessionId,
    limit: opts.hybridLimit,
    skipHot: opts.skipHot,
  })
}

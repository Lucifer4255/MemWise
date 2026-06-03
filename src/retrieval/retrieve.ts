import { cwd } from 'node:process'
import { RETRIEVE_HYBRID_LIMIT, RETRIEVE_MAX_TOKENS } from '../config.js'
import { getDefaultStore } from '../db.js'
import { defaultOllamaEmbed } from '../embed/ollama-client.js'
import { projectIdFromPath } from '../project.js'
import { countTokens, EMPTY_BLOCK, formatBundle } from './formatter.js'
import { searchAnchors, searchRecentAnchors } from './hybrid-search.js'
import { route } from './router.js'
import { expandAnchors } from './traversal.js'
import type { RetrieveOptions, RetrieveResult } from './types.js'

export { countTokens } from './formatter.js'

export async function retrieve(
  query: string,
  opts: RetrieveOptions = {},
): Promise<RetrieveResult> {
  const t0 = performance.now()
  const trimmed = query.trim()

  if (!trimmed) {
    return {
      block: EMPTY_BLOCK,
      tokenCount: countTokens(EMPTY_BLOCK),
      anchors: [],
      timingMs: performance.now() - t0,
    }
  }

  const projectId = opts.projectId ?? projectIdFromPath(cwd())
  const store = opts.store ?? getDefaultStore().store
  const embedFn = opts.embedFn ?? defaultOllamaEmbed
  const hybridLimit = opts.hybridLimit ?? RETRIEVE_HYBRID_LIMIT
  const maxTokens = opts.maxTokens ?? RETRIEVE_MAX_TOKENS

  const routeResult = opts.mode ? { mode: opts.mode } : route(trimmed, store)
  let anchors

  if (routeResult.mode === 'recency' || routeResult.mode === 'session') {
    anchors = await searchRecentAnchors(store, projectId, hybridLimit)
  } else {
    let embedding: number[] = []
    try {
      embedding = await embedFn(trimmed)
    } catch {
      embedding = []
    }
    anchors = await searchAnchors({
      projectId,
      query: trimmed,
      embedding,
      store,
      redis: opts.redis,
      sessionId: opts.sessionId,
      limit: hybridLimit,
      skipHot: opts.skipHot,
    })
  }

  if (anchors.length === 0) {
    return {
      block: EMPTY_BLOCK,
      tokenCount: countTokens(EMPTY_BLOCK),
      anchors: [],
      timingMs: performance.now() - t0,
    }
  }

  const bundle = expandAnchors({ store, anchors, route: routeResult })
  if (routeResult.mode === 'session') {
    bundle.recentPrompts = store.queryRecentPromptSigs(projectId, hybridLimit)
  }
  const { block, tokenCount } = formatBundle(bundle, maxTokens)

  return {
    block,
    tokenCount,
    anchors,
    timingMs: performance.now() - t0,
  }
}

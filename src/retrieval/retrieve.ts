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
    // Everything is in SQLite the moment a turn ends — recency reads the cold store directly.
    anchors = searchRecentAnchors(store, projectId, hybridLimit)
  } else {
    let embedding: number[] = []
    try {
      embedding = await embedFn(trimmed)
    } catch {
      embedding = []
    }
    anchors = searchAnchors({
      projectId,
      query: trimmed,
      embedding,
      store,
      limit: hybridLimit,
    })
    // Safety net: a semantic/symbol query that matches nothing (or whose embedding momentarily
    // failed) should still surface recent context rather than "no matching memory" — the project
    // clearly has work the user wants to recall. Degrade to recency instead of an empty block.
    if (anchors.length === 0) {
      anchors = searchRecentAnchors(store, projectId, hybridLimit)
    }
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
    bundle.latestSummary = store.queryLatestSessionSummary(projectId)
  }
  const { block, tokenCount } = formatBundle(bundle, maxTokens)

  return {
    block,
    tokenCount,
    anchors,
    timingMs: performance.now() - t0,
  }
}

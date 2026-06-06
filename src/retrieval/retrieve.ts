import { cwd } from 'node:process'
import { RETRIEVE_HYBRID_LIMIT, RETRIEVE_MAX_TOKENS } from '../core/config.js'
import { getDefaultStore } from '../core/db.js'
import { defaultOllamaEmbed } from '../embed/ollama-client.js'
import { projectIdFromPath } from '../core/project.js'
import { countTokens, EMPTY_BLOCK, formatBundle } from './formatter.js'
import { searchAnchors, searchRecentAnchors } from './hybrid-search.js'
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
  const mode = opts.mode ?? 'semantic'

  let anchors

  if (mode === 'recency' || mode === 'session') {
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
    // Fallback: if hybrid search returns nothing, surface recent context rather than empty.
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

  const bundle = expandAnchors({ store, anchors, mode })
  if (mode === 'session') {
    bundle.recentPrompts = store.queryRecentPromptSigs(projectId, hybridLimit)
    bundle.latestSummary = store.queryLatestSessionSummary(projectId)
  }
  // Durable tiers (M2): surface the project's top facts/workflows in semantic + session modes.
  if (mode === 'session' || mode === 'semantic') {
    bundle.semanticFacts = store.querySemanticFacts(projectId, 8)
    bundle.proceduralPatterns = store.queryProcedural(projectId, 5)
  }
  const { block, tokenCount } = formatBundle(bundle, maxTokens)

  return {
    block,
    tokenCount,
    anchors,
    timingMs: performance.now() - t0,
  }
}

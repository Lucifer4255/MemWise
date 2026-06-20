import { cwd } from 'node:process'
import { DECISION_TIER_ENABLED, DURABLE_TIERS_ENABLED, RETRIEVE_HYBRID_LIMIT, RETRIEVE_MAX_TOKENS } from '../core/config.js'
import { getDefaultStore } from '../core/db.js'
import { defaultOllamaEmbed } from '../embed/ollama-client.js'
import { projectIdFromPath } from '../core/project.js'
import { countTokens, EMPTY_BLOCK, formatBundle } from './formatter.js'
import { searchAnchors, searchRecentAnchors } from './hybrid-search.js'
import { expandAnchors } from './traversal.js'
import type { MemoryStore } from '../store/memory-store.js'
import type { AnchorHit, RetrieveOptions, RetrieveResult } from './types.js'

// Layer 14 — coarse-to-fine: match SESSION nodes by the query vector, then drill into their member
// turns. Surfaces related history the turn-level vector search alone would miss (a turn from a
// relevant session that didn't itself rank). Returns extra anchors NOT already in `have`.
const SESSION_COARSE_TOP = 2
const SESSION_DRILL_MAX = 5
function drillSessions(
  store: MemoryStore,
  projectId: string,
  embedding: number[],
  have: Set<string>,
): AnchorHit[] {
  if (embedding.length === 0) return []
  const extra: AnchorHit[] = []
  for (const node of store.querySessionNodesByVector(projectId, embedding, SESSION_COARSE_TOP)) {
    for (const sig of store.getSessionMemberTurns(node.nodeSig)) {
      if (have.has(sig) || extra.length >= SESSION_DRILL_MAX) continue
      const chunk = store.getContextChunkBySig(sig)
      if (!chunk) continue
      have.add(sig)
      extra.push({ sig, text: chunk.text, ts: chunk.ts, sources: ['session'] })
    }
  }
  return extra
}

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

  let anchors: AnchorHit[]
  let embedding: number[] = []

  if (mode === 'recency' || mode === 'session') {
    anchors = searchRecentAnchors(store, projectId, hybridLimit)
  } else {
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
    // Layer 14 coarse-to-fine: drill matched SESSION nodes into member turns (related history the
    // turn-level vector missed). Appended AFTER the primary anchors so ranking is preserved.
    const have = new Set(anchors.map(a => a.sig))
    anchors = [...anchors, ...drillSessions(store, projectId, embedding, have)]
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
  // Off by default for v0.1 (MEMWISE_DURABLE_TIERS=on to enable).
  if (DURABLE_TIERS_ENABLED && (mode === 'session' || mode === 'semantic')) {
    bundle.semanticFacts = store.querySemanticFacts(projectId, 8)
    bundle.proceduralPatterns = store.queryProcedural(projectId, 5)
  }
  // Layer 14 — attach the "why": active (non-superseded) decisions. Superseded ones are excluded by
  // queryActiveDecisions/queryDecisionsByVector, so the agent sees CURRENT truth. Gated by the tier.
  if (DECISION_TIER_ENABLED) {
    bundle.decisions =
      mode === 'session'
        ? store.queryActiveDecisions(projectId, 5)
        : embedding.length > 0
          ? store.queryDecisionsByVector(projectId, embedding, 4)
          : []
  }
  const { block, tokenCount } = formatBundle(bundle, maxTokens)

  return {
    block,
    tokenCount,
    anchors,
    timingMs: performance.now() - t0,
  }
}

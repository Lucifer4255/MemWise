import { createHash } from 'node:crypto'
import {
  CONSOLIDATE_TIMEOUT_MS,
  DECISION_MIN_NEW_CHUNKS,
  DECISION_TIER_ENABLED,
  ENRICH_ENABLED,
} from '../core/config.js'
import { GenerateClient } from '../embed/generate-client.js'
import { defaultOllamaEmbed, type EmbedFn } from '../embed/ollama-client.js'
import type { SqliteStore } from '../store/sqlite-store.js'
import { buildMaterial, isJunkText, parseJsonLoose } from './consolidate-utils.js'

const SYSTEM = [
  'You maintain a log of DECISIONS made on a software project, distilled from session notes.',
  'A decision is a deliberate choice with a reason: "use X because Y", "drop Z in favour of W",',
  '"store A as B". Not every note is a decision — skip routine work narration, questions, and output.',
  'You are shown the decisions already on record (with ids). When a new decision REVERSES or replaces',
  'an existing one, list that id in the new decision\'s "supersedes" array (e.g. "drop Redis" supersedes',
  '"use Redis"). Each decision: a present-tense STATEMENT (the choice) + a short RATIONALE (the why).',
  'Output STRICT JSON only, no prose, no code fences:',
  '{"decisions":[{"statement":"...","rationale":"...","confidence":0.0-1.0,"supersedes":["<id>"]}]}',
].join('\n')

interface DecisionResponse {
  decisions?: { statement?: string; rationale?: string; confidence?: number; supersedes?: string[] }[]
}

export interface ExtractDecisionOpts {
  minNewChunks?: number
  client?: GenerateClient
  embedFn?: EmbedFn
}

const decisionId = (projectId: string, statement: string) =>
  createHash('sha256').update(`${projectId}\x00${statement.trim().toLowerCase()}`).digest('hex').slice(0, 32)

/**
 * Job 5 (Layer 14) — decision consolidation. Promotes the parent/"Why" chain into Decision graph
 * nodes so "why did we pick X" is one hop, not a chain walk. Extracts decisions from recent
 * change-linked context, links each to the turns that realized it ('realized_by'), and when a new
 * decision reverses an old one, writes a 'supersedes' edge + stamps superseded_by (old row KEPT, so
 * "what changed" stays answerable). Gated behind MEMWISE_DECISION_TIER (default off). Graceful no-op
 * on missing model / bad output.
 */
export async function maybeExtractDecisions(
  store: SqliteStore,
  projectId: string,
  opts: ExtractDecisionOpts = {},
): Promise<boolean> {
  if (!DECISION_TIER_ENABLED) return false
  const minNew = opts.minNewChunks ?? DECISION_MIN_NEW_CHUNKS
  const active = store.queryActiveDecisions(projectId, 200)
  const sinceTs = active.reduce((mx, d) => Math.max(mx, d.lastSeen), 0)
  if (store.countChunksSince(projectId, sinceTs) < minNew) return false

  const client = opts.client ?? new GenerateClient()
  if (ENRICH_ENABLED === 'off') return false
  if (ENRICH_ENABLED === 'auto' && !(await client.isAvailable())) return false

  // Decisions live in change-linked turns (the "why" behind real edits), not chatter. The sigs of
  // these chunks are the turns a fresh decision is taken to be realized_by.
  const summaries = store.queryRecentSessionSummaries(projectId, 5)
  let chunks = store.queryRecentChangeLinkedChunks(projectId, 15)
  if (chunks.length < 3) chunks = store.queryRecentChunks(projectId, 15)
  const memberSigs = [...new Set(chunks.map(c => c.sig))]
  const material = buildMaterial(summaries.map(s => s.summary), chunks.map(c => c.text))
  if (!material.trim()) return false

  const known = active.length
    ? active.map(d => `- (${d.id}) ${d.statement}`).join('\n')
    : '(none yet)'
  const prompt = `Decisions on record:\n${known}\n\nRecent notes:\n${material}\n\nReturn the JSON:`

  const now = Date.now()
  try {
    const parsed = parseJsonLoose<DecisionResponse>(
      await client.generate(prompt, SYSTEM, CONSOLIDATE_TIMEOUT_MS, { json: true }),
    )
    if (!parsed) return false

    const activeIds = new Set(active.map(d => d.id))
    const embed = opts.embedFn ?? defaultOllamaEmbed
    let inserted = 0
    let superseded = 0
    for (const nd of parsed.decisions ?? []) {
      const statement = (nd.statement ?? '').trim()
      if (isJunkText(statement)) continue
      const id = decisionId(projectId, statement)
      const rationale = (nd.rationale ?? '').trim()
      const confidence = typeof nd.confidence === 'number' ? Math.max(0, Math.min(1, nd.confidence)) : 0.6

      let embedding: number[] = []
      try {
        embedding = await embed(`${statement}\n${rationale}`)
      } catch {
        embedding = []
      }
      store.upsertDecision(
        { id, projectId, statement, rationale, confidence, createdTs: now, lastSeen: now, supersededBy: '' },
        embedding,
      )
      // realized_by: link the decision to the change-linked turns in this window.
      if (memberSigs.length) store.insertRealizedByEdges(id, memberSigs, now)
      // supersedes: only honor ids that match a known active decision (small models hallucinate ids).
      for (const oldId of nd.supersedes ?? []) {
        if (activeIds.has(oldId) && oldId !== id) {
          store.markDecisionSuperseded(oldId, id, now)
          superseded++
        }
      }
      inserted++
    }
    store.insertTelemetry('job5', { projectId, inserted, superseded, members: memberSigs.length })
    return inserted > 0
  } catch {
    return false
  }
}

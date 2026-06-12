import { createHash } from 'node:crypto'
import { CONSOLIDATE_TIMEOUT_MS, ENRICH_ENABLED, SEMANTIC_MIN_NEW_CHUNKS } from '../core/config.js'
import { isEvictable } from '../core/decay.js'
import { GenerateClient } from '../embed/generate-client.js'
import type { SqliteStore } from '../store/sqlite-store.js'
import { buildMaterial, isJunkText, parseJsonLoose } from './consolidate-utils.js'

const SYSTEM = [
  'You maintain a knowledge base of DURABLE facts about a software project, distilled from session notes.',
  'The notes are mostly past-tense work narration ("Modified X to do Y", "Added Z"). Your job is to infer',
  'the STABLE TRUTH behind the work and state it in the PRESENT TENSE: architecture, tech choices, file',
  'responsibilities, conventions, constraints, decisions. e.g. "Modified enricher to prepend a TL;DR" →',
  '"The enricher prepends a one-line TL;DR to code-change turns." Skip pure chatter with no project fact',
  '(questions, terminal output, "ran the tests").',
  'You are also shown the facts already known — mark which are reinforced by the new notes, and which',
  'are now CONTRADICTED (no longer true) so they can be removed.',
  'Rules: be factual, never invent, never copy a verbatim numeric claim you are unsure of. Each fact is',
  'ONE present-tense sentence. Output STRICT JSON only, no prose, no code fences:',
  '{"newFacts":[{"fact":"...","confidence":0.0-1.0}],"reinforced":["<id>"],"contradicted":["<id>"]}',
].join('\n')

interface SemanticResponse {
  newFacts?: { fact?: string; confidence?: number }[]
  reinforced?: string[]
  contradicted?: string[]
}

export interface ExtractOpts {
  minNewChunks?: number
  client?: GenerateClient
}

const factId = (projectId: string, fact: string) =>
  createHash('sha256').update(`${projectId}\x00${fact.trim().toLowerCase()}`).digest('hex').slice(0, 32)

/**
 * Job 3 — semantic consolidation. When enough new chunks have landed, ask the local model to extract
 * durable facts from recent enriched context + summaries, dedup/reinforce against known facts, drop
 * contradicted ones, and evict decayed ones. Graceful: no model / bad output → no-op.
 */
export async function maybeExtractSemantic(
  store: SqliteStore,
  projectId: string,
  opts: ExtractOpts = {},
): Promise<boolean> {
  const minNew = opts.minNewChunks ?? SEMANTIC_MIN_NEW_CHUNKS
  const existing = store.querySemanticFacts(projectId, 200)
  const sinceTs = existing.reduce((mx, f) => Math.max(mx, f.lastSeen), 0)
  if (store.countChunksSince(projectId, sinceTs) < minNew) return false

  const client = opts.client ?? new GenerateClient()
  if (ENRICH_ENABLED === 'off') return false
  if (ENRICH_ENABLED === 'auto' && !(await client.isAvailable())) return false

  const summaries = store.queryRecentSessionSummaries(projectId, 5)
  // Prefer chunks tied to real code changes — they carry project facts, not discussion/terminal noise.
  // Fall back to plain recent chunks for a fresh project that has no tracked edits yet.
  let chunks = store.queryRecentChangeLinkedChunks(projectId, 15)
  if (chunks.length < 3) chunks = store.queryRecentChunks(projectId, 15)
  const material = buildMaterial(summaries.map(s => s.summary), chunks.map(c => c.text))
  if (!material.trim()) return false

  const known = existing.length
    ? existing.map(f => `- (${f.id}) ${f.fact}`).join('\n')
    : '(none yet)'
  const prompt = `Known facts:\n${known}\n\nRecent notes:\n${material}\n\nReturn the JSON:`

  const now = Date.now()
  try {
    const parsed = parseJsonLoose<SemanticResponse>(
      await client.generate(prompt, SYSTEM, CONSOLIDATE_TIMEOUT_MS, { json: true }),
    )
    if (!parsed) return false

    const existingIds = new Set(existing.map(f => f.id))
    let inserted = 0
    for (const nf of parsed.newFacts ?? []) {
      const text = (nf.fact ?? '').trim()
      if (isJunkText(text)) continue
      const confidence = typeof nf.confidence === 'number' ? Math.max(0, Math.min(1, nf.confidence)) : 0.6
      store.upsertSemanticFact({ id: factId(projectId, text), projectId, fact: text, confidence, lastSeen: now })
      inserted++
    }
    // Only count reinforcements that actually matched a known fact — small models hallucinate ids
    // (e.g. [""]), which must not be reported as work done.
    let reinforced = 0
    for (const id of parsed.reinforced ?? []) {
      if (existingIds.has(id)) {
        store.reinforceSemanticFact(id, 0.6, now)
        reinforced++
      }
    }
    for (const id of parsed.contradicted ?? []) {
      if (existingIds.has(id)) store.deleteSemanticFact(id)
    }
    // Eviction: prune facts that have decayed below the floor (strong/recent ones survive).
    let evicted = 0
    for (const f of existing) {
      if (isEvictable(f.support, f.lastSeen, now)) {
        store.deleteSemanticFact(f.id)
        evicted++
      }
    }
    store.insertTelemetry('job3', {
      projectId,
      inserted,
      reinforced,
      contradicted: (parsed.contradicted ?? []).length,
      evicted,
    })
    return inserted > 0 || reinforced > 0
  } catch {
    return false
  }
}

import { createHash } from 'node:crypto'
import { CONSOLIDATE_TIMEOUT_MS, ENRICH_ENABLED, PROCEDURAL_MIN_NEW_CHUNKS } from '../core/config.js'
import { isEvictable } from '../core/decay.js'
import { GenerateClient } from '../embed/generate-client.js'
import type { SqliteStore } from '../store/sqlite-store.js'
import { buildMaterial, isJunkText, parseJsonLoose } from './consolidate-utils.js'

const SYSTEM = [
  'You extract reusable HOW-TO procedures from recent coding-session notes — the "how we do things',
  'here" knowledge a future agent should follow. If a note says "to do X: a, b, c", that IS a',
  'procedure — extract it (even from a single mention). Skip one-off task narration with no reusable',
  'steps ("fixed a typo in README").',
  'Example input: "To deploy: run build, push image, apply manifest."',
  'Example output: {"newPatterns":[{"pattern":"deploy the service","sequence":["run build","push image","apply manifest"]}],"reinforced":[]}',
  'You are shown the patterns already known — mark which are reinforced by the new notes.',
  'Rules: be factual, never invent. `pattern` names the procedure in a short phrase; `sequence` is an',
  'ordered list of concise steps. Output STRICT JSON only, no prose, no code fences:',
  '{"newPatterns":[{"pattern":"...","sequence":["step1","step2"]}],"reinforced":["<id>"]}',
].join('\n')

interface ProceduralResponse {
  newPatterns?: { pattern?: string; sequence?: string[] }[]
  reinforced?: string[]
}

export interface ExtractOpts {
  minNewChunks?: number
  client?: GenerateClient
}

const patternId = (projectId: string, pattern: string) =>
  createHash('sha256').update(`${projectId}\x00${pattern.trim().toLowerCase()}`).digest('hex').slice(0, 32)

/**
 * Job 4 — procedural consolidation. When enough new chunks have landed, extract recurring workflows
 * from recent context + summaries, dedup/reinforce against known patterns, evict decayed ones.
 * Graceful: no model / bad output → no-op.
 */
export async function maybeExtractProcedural(
  store: SqliteStore,
  projectId: string,
  opts: ExtractOpts = {},
): Promise<boolean> {
  const minNew = opts.minNewChunks ?? PROCEDURAL_MIN_NEW_CHUNKS
  const existing = store.queryProcedural(projectId, 200)
  const sinceTs = existing.reduce((mx, p) => Math.max(mx, p.lastSeen), 0)
  if (store.countChunksSince(projectId, sinceTs) < minNew) return false

  const client = opts.client ?? new GenerateClient()
  if (ENRICH_ENABLED === 'off') return false
  if (ENRICH_ENABLED === 'auto' && !(await client.isAvailable())) return false

  const summaries = store.queryRecentSessionSummaries(projectId, 5)
  const chunks = store.queryRecentChunks(projectId, 15)
  const material = buildMaterial(summaries.map(s => s.summary), chunks.map(c => c.text))
  if (!material.trim()) return false

  const known = existing.length
    ? existing.map(p => `- (${p.id}) ${p.pattern}`).join('\n')
    : '(none yet)'
  const prompt = `Known patterns:\n${known}\n\nRecent notes:\n${material}\n\nReturn the JSON:`

  const now = Date.now()
  try {
    const parsed = parseJsonLoose<ProceduralResponse>(
      await client.generate(prompt, SYSTEM, CONSOLIDATE_TIMEOUT_MS, { json: true }),
    )
    if (!parsed) return false

    const existingIds = new Set(existing.map(p => p.id))
    let inserted = 0
    for (const np of parsed.newPatterns ?? []) {
      const pattern = (np.pattern ?? '').trim()
      if (isJunkText(pattern)) continue
      const sequence = JSON.stringify(Array.isArray(np.sequence) ? np.sequence : [])
      store.upsertProcedural({ id: patternId(projectId, pattern), projectId, pattern, sequence, lastSeen: now })
      inserted++
    }
    // Only count reinforcements that matched a known pattern — small models hallucinate ids (e.g. [""]),
    // which must not be reported as work done.
    let reinforced = 0
    for (const id of parsed.reinforced ?? []) {
      if (existingIds.has(id)) {
        store.reinforceProcedural(id, now)
        reinforced++
      }
    }
    let evicted = 0
    for (const p of existing) {
      if (isEvictable(p.freq, p.lastSeen, now)) {
        store.deleteProcedural(p.id)
        evicted++
      }
    }
    store.insertTelemetry('job4', {
      projectId,
      inserted,
      reinforced,
      evicted,
    })
    return inserted > 0 || reinforced > 0
  } catch {
    return false
  }
}

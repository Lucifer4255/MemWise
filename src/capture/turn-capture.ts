import { getAdapter } from '../adapters/index.js'
import type { AgentSource, TranscriptHint } from '../adapters/common.js'
import { EPISODIC_MIN_NEW_CHUNKS } from '../config.js'
import { Embedder } from '../embed/embedder.js'
import type { EmbedFn } from '../embed/ollama-client.js'
import { Enricher } from '../enrich/enricher.js'
import { maybeConsolidate } from '../enrich/episodic.js'
import { BracketManager } from '../bracket.js'
import { projectIdFromPath } from '../project.js'
import type { SqliteStore } from '../store/sqlite-store.js'
import type { FinalizedMessage } from '../types.js'
import { persistMessage } from './persist.js'

export interface CaptureDeps {
  store: SqliteStore
  /** Embedder (real Ollama by default). For tests/replay, pass `embedFn` for determinism. */
  embedder?: Embedder
  embedFn?: EmbedFn
  enricher?: Enricher
  /** Skip the opportunistic Job 2 episodic pass (tests). */
  skipConsolidate?: boolean
  /** Which agent's transcript this is (selects the reader/parser Strategy). */
  source?: AgentSource
  /** Scope fallback from the live hook payload (Cursor transcripts lack session/project). */
  hint?: TranscriptHint
}

export interface CaptureResult {
  sessionId: string
  projectId: string
  /** Messages newly written this call (already-captured sigs are skipped). */
  captured: number
  /** Turns seen in the transcript (incl. already-captured). */
  turns: number
}

/**
 * Capture every not-yet-stored turn from a Claude Code transcript. The transcript on disk is the
 * source of truth: we replay it through a fresh in-process BracketManager (no Redis, no
 * cross-process snapshot), and for each finalized message we enrich → embed → write once.
 *
 * Idempotent: a message's `sig` is deterministic, so a turn already in `prompt_sig` is skipped —
 * which is what makes the Stop trigger and the next-prompt safety net safe to both fire, and makes
 * a cancelled turn recoverable at the next trigger without duplication.
 */
export async function captureFromTranscript(
  transcriptPath: string,
  deps: CaptureDeps,
): Promise<CaptureResult> {
  const { store } = deps
  const embedder = deps.embedder ?? new Embedder(deps.embedFn)
  const enricher = deps.enricher ?? new Enricher()
  const adapter = getAdapter(deps.source ?? 'claude-code')

  const { events, sessionId, projectPath } = adapter.readTranscript(transcriptPath, deps.hint)
  const projectId = projectIdFromPath(projectPath)

  const brackets = new BracketManager()
  let seq = 1
  let captured = 0
  let turns = 0

  for (const { payload, ts } of events) {
    const ev = adapter.parseHook(payload, { seq: seq++ })
    if (!ev) continue // unknown hook or non-final narration delta
    ev.sessionId = sessionId
    ev.ts = ts

    if (ev.hook === 'TOOL' || ev.hook === 'TOOL_BATCH') brackets.addTouchedFile(ev)
    const finalized = brackets.handle(ev)
    if (!finalized) continue

    turns++
    // Idempotency + cost gate: skip already-captured turns BEFORE the expensive enrich/embed.
    if (store.getPromptSig(finalized.sig)) continue

    await captureOne(store, embedder, enricher, finalized)
    captured++
  }

  if (events.length > 0) {
    store.setCaptureCursor({ sessionId, lastUuid: lastUuidOf(events), ts: Date.now() })
  }

  if (!deps.skipConsolidate && captured > 0) {
    await maybeConsolidate(store, projectId, { minNewChunks: EPISODIC_MIN_NEW_CHUNKS, enricher })
  }

  return { sessionId, projectId, captured, turns }
}

/** Enrich → embed → single atomic write, with telemetry. Failures degrade to raw text. */
async function captureOne(
  store: SqliteStore,
  embedder: Embedder,
  enricher: Enricher,
  msg: FinalizedMessage,
): Promise<void> {
  const enrichment = await enricher.enrich(msg)
  store.insertTelemetry('enrich', {
    sig: msg.sig,
    enriched: enrichment.enriched,
    ms: Math.round(enrichment.ms),
    model: enrichment.model,
  })

  const t0 = performance.now()
  let embedding: number[] = []
  try {
    embedding = await embedder.embed(enrichment.text)
  } catch {
    embedding = [] // embed failure → vector-less row; catch-up fills it later
  }
  const embedMs = Math.round(performance.now() - t0)

  persistMessage(store, msg, enrichment.text, embedding, enrichment.enriched)

  store.insertTelemetry('embed', {
    sig: msg.sig,
    ms: embedMs,
    dim: embedding.length,
    tokens: Math.ceil(enrichment.text.length / 4),
  })
  store.insertTelemetry('message', {
    sig: msg.sig,
    projectId: msg.projectId,
    promptText: msg.promptText.slice(0, 200),
    changes: msg.codeChanges.length,
    enriched: enrichment.enriched,
  })
}

/** A stable marker for the cursor — the last assistant message id we saw, else the event count. */
function lastUuidOf(events: { payload: Record<string, unknown> }[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const id = events[i]!.payload.message_id
    if (typeof id === 'string') return id
  }
  return String(events.length)
}

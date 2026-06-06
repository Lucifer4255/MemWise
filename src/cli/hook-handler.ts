import { parseHook } from '../adapters/index.js'
import type { RawHookPayload, TranscriptHint } from '../adapters/common.js'
import { captureFromTranscript } from '../capture/turn-capture.js'
import { getDefaultStore } from '../core/db.js'
import { projectIdFromPath } from '../core/project.js'
import type { CaptureEvent } from '../core/types.js'
import { injectContext } from './inject.js'

/**
 * Hook entry point — transcript-sourced capture, no Redis.
 *
 * The transcript on disk is the source of truth. We only need three triggers:
 *  - Stop                → capture the just-finished turn(s) from the transcript
 *  - UserPromptSubmit    → safety net: capture the PREVIOUS turn before the new one starts
 *                          (covers a cancelled turn where Stop never fired)
 *  - PreCompact          → catch-up capture before Claude wipes context
 * Capture is idempotent (deterministic sig → already-stored turns are skipped), so Stop and the
 * next UserPromptSubmit both firing is safe. PostCompact still records Claude's compaction summary.
 */
export async function handleHook(
  rawJson: string,
  source: CaptureEvent['source'] = 'claude-code',
): Promise<void> {
  const raw = JSON.parse(rawJson) as RawHookPayload
  const event = parseHook(source, raw, { seq: 0 })
  const { store } = getDefaultStore()

  const transcriptPath = (raw.transcript_path as string | undefined) ?? event?.transcriptPath ?? null
  // Scope fallback for transcripts whose entries don't carry session/project (Cursor).
  const hint: TranscriptHint = {
    ...(event?.sessionId ? { sessionId: event.sessionId } : {}),
    ...(event?.projectPath ? { projectPath: event.projectPath } : {}),
  }

  // ── SESSION_START: inject context, then catch up anything past the cursor ──
  if (event?.hook === 'SESSION_START') {
    await injectContext(event, store, true)
    if (transcriptPath) await safeCapture(transcriptPath, store, source, hint)
    return
  }

  // ── PostCompact: persist Claude's compaction summary (unchanged) ──
  if (event?.hook === 'POST_COMPACT') {
    const summary =
      (raw.compact_summary as string | undefined) ??
      (raw.last_assistant_message as string | undefined) ??
      ''
    if (summary.trim() && event) {
      const projectId = projectIdFromPath(event.projectPath)
      try {
        store.insertSessionSummary({
          projectId,
          source: 'postcompact',
          sigRange: '',
          summary: summary.trim(),
          ts: Date.now(),
        })
      } catch (err) {
        process.stderr.write(`[memwise] insertSessionSummary failed: ${String(err)}\n`)
      }
    }
    return
  }

  // ── Stop / UserPromptSubmit / PreCompact (and SESSION_START above): capture from transcript ──
  // For UserPromptSubmit this captures the *previous* turn (the new prompt isn't finalized yet),
  // which is exactly the cancelled-turn safety net.
  if (transcriptPath) {
    await safeCapture(transcriptPath, store, source, hint)
  }
}

async function safeCapture(
  transcriptPath: string,
  store: ReturnType<typeof getDefaultStore>['store'],
  source: CaptureEvent['source'],
  hint: TranscriptHint,
): Promise<void> {
  try {
    await captureFromTranscript(transcriptPath, { store, source, hint })
  } catch (err) {
    process.stderr.write(`[memwise] capture failed: ${String(err)}\n`)
  }
}

import { readFileSync } from 'node:fs'
import type { RawHookPayload, ReplayEvent, TranscriptHint, TranscriptRead } from '../adapters/common.js'

/**
 * Reads a Cursor agent transcript (`~/.cursor/projects/<enc>/agent-transcripts/<id>/<id>.jsonl`)
 * and re-emits Cursor-shaped hook payloads that `parseCursorHook` consumes — the same
 * transcript→payload→parseHook path the Claude reader uses, just for Cursor's format.
 *
 * Cursor's format differs from Claude's: entries are `{role, message:{content:[...]}}` (no
 * per-entry sessionId/cwd/timestamp), user text is wrapped in `<user_query>…</user_query>`, and
 * edits use `StrReplace`/`Write`/`Delete` with a `path` field. Scope (session/project) comes from
 * the hook payload via `hint`, since the transcript entries don't carry it.
 */

interface CursorPart {
  type?: string
  text?: string
  name?: string
  input?: Record<string, unknown>
}

interface CursorEntry {
  role?: string
  message?: { content?: unknown }
}

/** Pull the real prompt out of Cursor's `<timestamp>…</timestamp>\n<user_query>…</user_query>` wrapper. */
function unwrapUserQuery(text: string): string | null {
  const m = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/)
  const inner = m ? m[1]! : text.replace(/<timestamp>[\s\S]*?<\/timestamp>/g, '')
  const clean = inner.trim()
  return clean.length ? clean : null
}

function userText(content: unknown): string | null {
  if (typeof content === 'string') return unwrapUserQuery(content)
  if (Array.isArray(content)) {
    const texts = (content as CursorPart[])
      .filter(p => p?.type === 'text' && typeof p.text === 'string')
      .map(p => p.text as string)
    if (texts.length) return unwrapUserQuery(texts.join('\n'))
  }
  return null
}

/** Map a Cursor edit tool's input to the shape codeChangesFromToolEvent + inferChangeType expect. */
function normalizeToolInput(name: string, input: Record<string, unknown>): Record<string, unknown> {
  const path = typeof input.path === 'string' ? input.path : input.file_path
  if (name === 'StrReplace') {
    return { path, edits: [{ old_string: input.old_string ?? '', new_string: input.new_string ?? '' }] }
  }
  if (name === 'Write') {
    // `content` drives doc-folding + the Write→'added' heuristic (toolName Write).
    return { path, content: input.contents ?? input.content ?? '' }
  }
  if (name === 'Delete') {
    return { path }
  }
  return { ...input, ...(path ? { path } : {}) }
}

export function readCursorTranscript(path: string, hint?: TranscriptHint): TranscriptRead {
  const entries: CursorEntry[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      entries.push(JSON.parse(s) as CursorEntry)
    } catch {
      // skip malformed line
    }
  }

  const sessionId = hint?.sessionId ?? 'cursor-replay'
  const projectPath = hint?.projectPath ?? process.cwd()
  const baseTs = Date.now()
  const events: ReplayEvent[] = []
  let open = false
  let i = 0

  const emit = (payload: RawHookPayload): void => {
    events.push({
      payload: { session_id: sessionId, cwd: projectPath, transcript_path: path, ...payload },
      ts: baseTs + i++ * 1000,
    })
  }

  for (const e of entries) {
    const content = e.message?.content

    if (e.role === 'user') {
      const text = userText(content)
      if (!text) continue
      if (open) emit({ hook_event_name: 'stop', status: 'completed' })
      emit({ hook_event_name: 'beforeSubmitPrompt', prompt: text })
      open = true
      continue
    }

    if (e.role === 'assistant' && Array.isArray(content)) {
      for (const p of content as CursorPart[]) {
        if (!p || typeof p !== 'object') continue
        if (p.type === 'text' && p.text?.trim()) {
          // Mid-turn narration → NARRATION (non-closing) so it lands as a segment intent.
          emit({ hook_event_name: 'afterAgentThought', text: p.text })
        } else if (p.type === 'tool_use' && p.name) {
          emit({
            hook_event_name: 'postToolUse',
            tool_name: p.name,
            tool_input: normalizeToolInput(p.name, p.input ?? {}),
          })
        }
      }
    }
  }

  if (open) emit({ hook_event_name: 'stop', status: 'completed' })
  return { events, sessionId, projectPath }
}

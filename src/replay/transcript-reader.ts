import { readFileSync } from 'node:fs'
import type { RawHookPayload, ReplayEvent, TranscriptHint, TranscriptRead } from '../adapters/common.js'

export type { ReplayEvent, TranscriptRead } from '../adapters/common.js'

/**
 * Reads a Claude Code `.jsonl` transcript and re-emits it as the live hook payloads the
 * Layer 7 adapter consumes — so replay drives the SAME `parseClaudeCodeHook` path that real
 * hooks will, rather than a parallel mapping that could drift.
 *
 * Transcripts have no Stop entry, so a turn runs from one real user prompt to the next; a
 * synthetic Stop is emitted at each boundary (and at EOF) carrying the last assistant text.
 */

interface ContentPart {
  type?: string
  text?: string
  name?: string
  id?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  is_error?: boolean
  content?: unknown
}

interface RawEntry {
  type?: string
  uuid?: string
  message?: { content?: unknown }
  sessionId?: string
  cwd?: string
  timestamp?: string
  isMeta?: boolean
  isSidechain?: boolean
}

// Slash-command / harness artifacts that appear as `user` strings but aren't user intent.
const NOISE_PREFIXES = ['<local-command-caveat>', '<command-name>', '<command-message>', '<command-args>']

function tsMs(s?: string): number {
  const t = s ? Date.parse(s) : NaN
  return Number.isNaN(t) ? Date.now() : t
}

function stripReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
}

/** A `user` entry is a real prompt only when content is plain text with no tool_result part. */
function userPromptText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = content as ContentPart[]
    if (parts.some(p => p?.type === 'tool_result')) return null
    const texts = parts.filter(p => p?.type === 'text' && p.text).map(p => p.text as string)
    if (texts.length) return texts.join('\n')
  }
  return null
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  try {
    return JSON.stringify(content ?? '')
  } catch {
    return ''
  }
}

export function readTranscript(path: string, hint?: TranscriptHint): TranscriptRead {
  const entries: RawEntry[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      entries.push(JSON.parse(s) as RawEntry)
    } catch {
      // skip malformed line
    }
  }

  // Pass 1: tool_use_id → its result (for tool_response + failure detection).
  const results = new Map<string, { isError: boolean; content: string }>()
  for (const e of entries) {
    if (e.isSidechain) continue
    const c = e.message?.content
    if (e.type === 'user' && Array.isArray(c)) {
      for (const p of c as ContentPart[]) {
        if (p?.type === 'tool_result' && p.tool_use_id) {
          results.set(p.tool_use_id, { isError: p.is_error === true, content: resultText(p.content) })
        }
      }
    }
  }

  // Pass 2: emit payloads in order.
  const events: ReplayEvent[] = []
  let sessionId = hint?.sessionId ?? 'replay'
  let projectPath = hint?.projectPath ?? process.cwd()
  let open = false
  let lastAssistantText = ''
  let lastTs = Date.now()

  const emit = (payload: RawHookPayload, ts: number): void => {
    events.push({
      payload: { session_id: sessionId, cwd: projectPath, transcript_path: path, ...payload },
      ts,
    })
  }

  for (const e of entries) {
    if (e.isSidechain) continue
    if (e.sessionId) sessionId = e.sessionId
    if (e.cwd) projectPath = e.cwd
    const ts = tsMs(e.timestamp)
    lastTs = ts
    const content = e.message?.content

    if (e.type === 'user') {
      const raw = userPromptText(content)
      if (raw == null || e.isMeta) continue
      if (NOISE_PREFIXES.some(p => raw.startsWith(p))) continue
      const clean = stripReminders(raw)
      if (!clean) continue
      if (open) emit({ hook_event_name: 'Stop', last_assistant_message: lastAssistantText }, ts)
      emit({ hook_event_name: 'UserPromptSubmit', prompt: clean }, ts)
      open = true
      lastAssistantText = ''
      continue
    }

    if (e.type === 'assistant' && Array.isArray(content)) {
      for (const p of content as ContentPart[]) {
        if (!p || typeof p !== 'object') continue
        if (p.type === 'text' && p.text?.trim()) {
          lastAssistantText = p.text
          // final:true so the adapter's delta-buffer flushes this as one NARRATION immediately.
          emit(
            { hook_event_name: 'MessageDisplay', message_id: `${e.uuid ?? 'm'}:${events.length}`, index: 0, final: true, delta: p.text },
            ts,
          )
        } else if (p.type === 'tool_use' && p.name) {
          const res = p.id ? results.get(p.id) : undefined
          if (res?.isError) {
            emit(
              { hook_event_name: 'PostToolUseFailure', tool_name: p.name, tool_input: p.input ?? {}, error: res.content.slice(0, 2000) },
              ts,
            )
          } else {
            emit(
              { hook_event_name: 'PostToolUse', tool_name: p.name, tool_input: p.input ?? {}, tool_response: res?.content },
              ts,
            )
          }
        }
      }
    }
  }

  if (open) emit({ hook_event_name: 'Stop', last_assistant_message: lastAssistantText }, lastTs)
  return { events, sessionId, projectPath }
}

import { readFileSync } from 'node:fs'
import type { RawHookPayload, ReplayEvent, TranscriptHint, TranscriptRead } from '../adapters/common.js'

/**
 * Reads a Codex rollout transcript (`~/.codex/sessions/<…>/rollout-*.jsonl`) and re-emits
 * Claude-compatible hook payloads that `parseCodexHook` consumes.
 *
 * Codex's format is a `{timestamp, type, payload}` envelope: `session_meta` carries scope, and
 * `response_item` wraps messages (`input_text`/`output_text` parts) and tool calls
 * (`function_call` shell, `custom_tool_call` apply_patch). Codex has no live narration hook, so
 * assistant text is recovered here from the transcript (richer than the live event stream).
 */

interface CodexPart {
  type?: string
  text?: string
}

interface CodexPayload {
  type?: string
  role?: string
  content?: CodexPart[]
  // tool-call fields
  name?: string
  arguments?: string // function_call: JSON string
  input?: string // custom_tool_call (apply_patch): raw patch text
  id?: string
  cwd?: string
}

interface CodexEnvelope {
  timestamp?: string
  type?: string
  payload?: CodexPayload
}

// Injected/system user messages that aren't real prompts (mirrors the Claude reader's noise gate).
const NOISE_PREFIXES = ['# AGENTS.md', '<environment_context', '<user_instructions', '<permissions']

/**
 * Extract the real user prompt from a Codex user message, or null if it's pure injected context.
 * Codex's IDE integration wraps the actual ask inside a `# Context from my IDE setup:` block under
 * a `## My request…:` heading; environment/AGENTS.md messages carry no real prompt.
 */
function cleanPrompt(text: string): string | null {
  const t = text.trim()
  const req = t.match(/##\s*My request[^\n:]*:\s*([\s\S]*)$/i)
  if (req) {
    const inner = req[1]!.replace(/<image>\s*<\/image>/g, '').trim()
    return inner.length ? inner : null
  }
  if (t.startsWith('<') || NOISE_PREFIXES.some(p => t.startsWith(p)) || t.startsWith('# Context from my IDE')) {
    return null
  }
  return t.length ? t : null
}

function partsText(content: CodexPart[] | undefined, kind: 'input_text' | 'output_text'): string {
  if (!Array.isArray(content)) return ''
  return content.filter(p => p?.type === kind && typeof p.text === 'string').map(p => p.text as string).join('\n')
}

/** Map a Codex tool call to a Claude-compatible PostToolUse payload. */
function toolPayload(p: CodexPayload): RawHookPayload | null {
  const name = p.name ?? ''
  // apply_patch: the patch envelope is the change source (parsed by codeChangesFromToolEvent).
  if (name === 'apply_patch') {
    const patch = typeof p.input === 'string' ? p.input : argField(p.arguments, 'input') ?? argField(p.arguments, 'patch')
    if (!patch) return null
    return { hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: { command: patch } }
  }
  // Shell/exec: command may itself be an apply_patch heredoc (isApplyPatchCommand handles that).
  const command = argField(p.arguments, 'command') ?? argField(p.arguments, 'cmd')
  if (command) {
    return { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command } }
  }
  return null
}

/** Pull a string field out of a function_call `arguments` JSON string. `cmd` arrays are joined. */
function argField(args: string | undefined, key: string): string | null {
  if (!args) return null
  try {
    const o = JSON.parse(args) as Record<string, unknown>
    const v = o[key]
    if (typeof v === 'string') return v
    if (Array.isArray(v)) return v.filter(x => typeof x === 'string').join(' ')
  } catch {
    // not JSON
  }
  return null
}

export function readCodexRollout(path: string, hint?: TranscriptHint): TranscriptRead {
  const envelopes: CodexEnvelope[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      envelopes.push(JSON.parse(s) as CodexEnvelope)
    } catch {
      // skip malformed line
    }
  }

  let sessionId = hint?.sessionId ?? 'codex-replay'
  let projectPath = hint?.projectPath ?? process.cwd()
  const events: ReplayEvent[] = []
  let open = false
  let lastAssistant = ''
  let lastTs = Date.now()

  const emit = (payload: RawHookPayload, ts: number): void => {
    events.push({
      payload: { session_id: sessionId, cwd: projectPath, transcript_path: path, ...payload },
      ts,
    })
  }

  for (const env of envelopes) {
    const p = env.payload
    if (!p) continue
    const ts = env.timestamp ? Date.parse(env.timestamp) || Date.now() : Date.now()
    lastTs = ts

    if (env.type === 'session_meta') {
      if (!hint?.sessionId && typeof (p as { id?: string }).id === 'string') sessionId = (p as { id: string }).id
      if (!hint?.projectPath && typeof p.cwd === 'string') projectPath = p.cwd
      continue
    }

    if (env.type !== 'response_item') continue

    if (p.type === 'message') {
      if (p.role === 'user') {
        const prompt = cleanPrompt(partsText(p.content, 'input_text'))
        if (!prompt) continue
        if (open) emit({ hook_event_name: 'Stop', last_assistant_message: lastAssistant }, ts)
        emit({ hook_event_name: 'UserPromptSubmit', prompt }, ts)
        open = true
        lastAssistant = ''
      } else if (p.role === 'assistant') {
        const text = partsText(p.content, 'output_text').trim()
        if (text) {
          lastAssistant = text
          // Replay-only narration: Codex emits no live narration hook, but the transcript has it.
          emit({ hook_event_name: 'MessageDisplay', text }, ts)
        }
      }
      continue
    }

    if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      const payload = toolPayload(p)
      if (payload) emit(payload, ts)
    }
  }

  if (open) emit({ hook_event_name: 'Stop', last_assistant_message: lastAssistant }, lastTs)
  return { events, sessionId, projectPath }
}

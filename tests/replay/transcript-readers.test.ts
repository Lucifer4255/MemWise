import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAdapter } from '../../src/adapters/index.js'
import { BracketManager } from '../../src/capture/bracket.js'
import type { AgentSource, TranscriptHint } from '../../src/adapters/common.js'
import type { FinalizedMessage } from '../../src/core/types.js'

type TestResult = { name: string; ok: boolean; detail: string }
const pass = (name: string, detail = ''): TestResult => ({ name, ok: true, detail })
const fail = (name: string, detail: string): TestResult => ({ name, ok: false, detail })

/** Drive a transcript through its adapter (readTranscript → parseHook → bracket), as capture does. */
function capture(source: AgentSource, body: string, hint?: TranscriptHint): FinalizedMessage[] {
  const dir = mkdtempSync(join(tmpdir(), 'mw-readers-'))
  const path = join(dir, 'transcript.jsonl')
  writeFileSync(path, body, 'utf8')
  try {
    const adapter = getAdapter(source)
    const { events, sessionId } = adapter.readTranscript(path, hint)
    const brackets = new BracketManager()
    let seq = 1
    const out: FinalizedMessage[] = []
    for (const { payload } of events) {
      const ev = adapter.parseHook(payload, { seq: seq++ })
      if (!ev) continue
      ev.sessionId = sessionId
      if (ev.hook === 'TOOL' || ev.hook === 'TOOL_BATCH') brackets.addTouchedFile(ev)
      const fin = brackets.handle(ev)
      if (fin) out.push(fin)
    }
    return out
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const jl = (...objs: unknown[]): string => objs.map(o => JSON.stringify(o)).join('\n') + '\n'

function main(): void {
  const results: TestResult[] = []

  // ── 1. Cursor reader: <user_query> unwrap + Write/StrReplace/Delete → change types ──────────
  {
    const body = jl(
      { role: 'user', message: { content: [{ type: 'text', text: '<timestamp>now</timestamp>\n<user_query>\nbuild a counter\n</user_query>' }] } },
      { role: 'assistant', message: { content: [
        { type: 'text', text: 'Creating the file.' },
        { type: 'tool_use', name: 'Write', input: { path: '/ws/counter.ts', contents: 'export const c = 0' } },
      ] } },
      { role: 'user', message: { content: [{ type: 'text', text: '<user_query>tweak and clean up</user_query>' }] } },
      { role: 'assistant', message: { content: [
        { type: 'tool_use', name: 'StrReplace', input: { path: '/ws/counter.ts', old_string: 'c = 0', new_string: 'c = 1' } },
        { type: 'tool_use', name: 'Delete', input: { path: '/ws/old.ts' } },
      ] } },
    )
    const msgs = capture('cursor', body, { sessionId: 'cur-1', projectPath: '/ws' })
    const types = Object.fromEntries(msgs.flatMap(m => m.codeChanges).map(c => [c.file.split('/').pop(), c.changeType]))
    const prompts = msgs.map(m => m.promptText)
    if (
      msgs.length === 2 &&
      prompts[0] === 'build a counter' &&
      types['counter.ts'] && // first added, later modified — last write wins in the map; just assert present
      Object.values(types).includes('deleted')
    ) {
      results.push(pass('cursor reader', `${msgs.length} turns, types=${JSON.stringify(types)}`))
    } else {
      results.push(fail('cursor reader', `turns=${msgs.length} prompts=${JSON.stringify(prompts)} types=${JSON.stringify(types)}`))
    }
  }

  // ── 2. Cursor reader: added vs modified inference from edits ────────────────────────────────
  {
    const body = jl(
      { role: 'user', message: { content: [{ type: 'text', text: '<user_query>add file</user_query>' }] } },
      { role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { path: '/ws/new.ts', contents: 'x' } }] } },
    )
    const [m] = capture('cursor', body, { sessionId: 'cur-2', projectPath: '/ws' })
    if (m && m.codeChanges.some(c => c.file === '/ws/new.ts' && c.changeType === 'added')) {
      results.push(pass('cursor Write→added', 'new file inferred as added'))
    } else {
      results.push(fail('cursor Write→added', JSON.stringify(m?.codeChanges)))
    }
  }

  // ── 3. Codex reader: IDE-context prompt extraction + apply_patch change ─────────────────────
  {
    const body = jl(
      { timestamp: '2026-06-05T10:00:00.000Z', type: 'session_meta', payload: { id: 'codex-sess', cwd: '/repo' } },
      { timestamp: '2026-06-05T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /repo\n<INSTRUCTIONS>noise</INSTRUCTIONS>' }] } },
      { timestamp: '2026-06-05T10:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# Context from my IDE setup:\n## Active file: src/pay.ts\n\n## My request for Codex:\nadd retry to charge\n<image></image>' }] } },
      { timestamp: '2026-06-05T10:00:03.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Adding retry with backoff.' }] } },
      { timestamp: '2026-06-05T10:00:04.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: src/pay.ts\n@@\n-return charge()\n+return retry(charge)\n*** End Patch' } },
    )
    const msgs = capture('codex', body)
    const m = msgs[0]
    if (
      msgs.length === 1 &&
      m!.promptText === 'add retry to charge' &&
      m!.projectId === '/repo' &&
      m!.codeChanges.some(c => c.file === 'src/pay.ts' && c.changeType === 'modified') &&
      m!.contextText.includes('Adding retry with backoff')
    ) {
      results.push(pass('codex reader', `prompt extracted, apply_patch change, narration pooled`))
    } else {
      results.push(fail('codex reader', `turns=${msgs.length} prompt="${m?.promptText}" project=${m?.projectId} changes=${JSON.stringify(m?.codeChanges)}`))
    }
  }

  // ── 4. Codex reader: shell exec_command is not a code change ────────────────────────────────
  {
    const body = jl(
      { timestamp: '2026-06-05T10:00:00.000Z', type: 'session_meta', payload: { id: 's', cwd: '/repo' } },
      { timestamp: '2026-06-05T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run the tests' }] } },
      { timestamp: '2026-06-05T10:00:02.000Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm test', workdir: '/repo' }) } },
      { timestamp: '2026-06-05T10:00:03.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Tests pass.' }] } },
    )
    const msgs = capture('codex', body)
    // No code change, but a prompt+narration turn is still worth storing.
    if (msgs.length <= 1 && (msgs[0]?.codeChanges.length ?? 0) === 0) {
      results.push(pass('codex shell no-change', `exec_command produced 0 code changes`))
    } else {
      results.push(fail('codex shell no-change', JSON.stringify(msgs.map(m => m.codeChanges))))
    }
  }

  // ── 5. Registry: getAdapter returns the right source for each agent ─────────────────────────
  {
    const ok = (['claude-code', 'codex', 'cursor'] as AgentSource[]).every(s => getAdapter(s).source === s)
    if (ok) results.push(pass('registry getAdapter', 'all three sources resolve'))
    else results.push(fail('registry getAdapter', 'mismatch'))
  }

  console.log('\n── memwise transcript-reader tests ──\n')
  let passed = 0
  for (const r of results) {
    const icon = r.ok ? '✓' : '✗'
    const label = r.ok ? '\x1b[32m' : '\x1b[31m'
    console.log(`  ${label}${icon}\x1b[0m  ${r.name.padEnd(24)} ${r.detail}`)
    if (r.ok) passed++
  }
  console.log(`\n  ${passed}/${results.length} passed\n`)
  process.exit(passed === results.length ? 0 : 1)
}

main()

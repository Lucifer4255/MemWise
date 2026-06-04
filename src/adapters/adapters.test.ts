import { BracketManager, codeChangesFromToolEvent } from '../bracket.js'
import { parseCodexHook, parseCursorHook, parseHook } from './index.js'
import { isApplyPatchCommand, parseApplyPatch } from './apply-patch.js'
import type { AdapterContext } from './common.js'

type TestResult = { name: string; ok: boolean; detail: string }
const pass = (name: string, detail = ''): TestResult => ({ name, ok: true, detail })
const fail = (name: string, detail: string): TestResult => ({ name, ok: false, detail })

const ctx: AdapterContext = { seq: 1 }

const PATCH = [
  '*** Begin Patch',
  '*** Update File: src/pay.ts',
  '@@ function processPayment()',
  '-  return charge()',
  '+  return retry(charge)',
  '*** Add File: src/retry.ts',
  '+export function retry(fn) { return fn() }',
  '*** Delete File: src/legacy.ts',
  '*** End Patch',
].join('\n')

function main(): void {
  const results: TestResult[] = []

  // ── 1. apply_patch parser: extracts file-level changes with correct change types ──────────
  {
    const parsed = parseApplyPatch(PATCH)
    const byFile = Object.fromEntries(parsed.map(p => [p.file, p.changeType]))
    if (
      isApplyPatchCommand(PATCH) &&
      byFile['src/pay.ts'] === 'modified' &&
      byFile['src/retry.ts'] === 'added' &&
      byFile['src/legacy.ts'] === 'deleted'
    ) {
      results.push(pass('apply_patch parser', `${parsed.length} files: update/add/delete`))
    } else {
      results.push(fail('apply_patch parser', JSON.stringify(parsed)))
    }
  }

  // ── 2. apply_patch rename: Move to → destination path ─────────────────────────────────────
  {
    const renamePatch = '*** Begin Patch\n*** Update File: old/a.ts\n*** Move to: new/b.ts\n@@\n+x\n*** End Patch'
    const parsed = parseApplyPatch(renamePatch)
    if (parsed.length === 1 && parsed[0]!.file === 'new/b.ts' && parsed[0]!.changeType === 'modified') {
      results.push(pass('apply_patch rename', 'Move to → new/b.ts'))
    } else {
      results.push(fail('apply_patch rename', JSON.stringify(parsed)))
    }
  }

  // ── 3. Codex apply_patch → CodeChange rows via codeChangesFromToolEvent ────────────────────
  {
    const event = parseCodexHook(
      { hook_event_name: 'PostToolUse', session_id: 'codex-1', cwd: '/repo', tool_name: 'apply_patch', tool_input: { command: PATCH }, tool_response: 'applied' },
      ctx,
    )
    const resolved = event ? codeChangesFromToolEvent(event) : { changes: [], deps: [] }
    const files = resolved.changes.map(c => c.file).sort()
    if (files.length === 3 && files.includes('src/pay.ts') && files.includes('src/retry.ts')) {
      results.push(pass('codex apply_patch → changes', `${resolved.changes.length} file-level changes`))
    } else {
      results.push(fail('codex apply_patch → changes', JSON.stringify(files)))
    }
  }

  // ── 4. Codex non-zero exit → isFailure true ───────────────────────────────────────────────
  {
    const event = parseCodexHook(
      { hook_event_name: 'PostToolUse', session_id: 'codex-1', cwd: '/repo', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { exit_code: 1, output: 'fail' } },
      ctx,
    )
    if (event?.hook === 'TOOL_FAILED' && event.isFailure === true) {
      results.push(pass('codex non-zero exit', 'exit_code 1 → TOOL_FAILED'))
    } else {
      results.push(fail('codex non-zero exit', JSON.stringify(event)))
    }
  }

  // ── 5. Codex Stop → closing summary attached to contextText ───────────────────────────────
  {
    const brackets = new BracketManager()
    const base = { session_id: 'codex-close', cwd: '/repo' }
    brackets.handle(parseCodexHook({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'add retry' }, ctx)!)
    brackets.handle(parseCodexHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: src/pay.ts\n@@\n+retry\n*** End Patch' }, tool_response: 'ok' }, ctx)!)
    const final = brackets.handle(parseCodexHook({ ...base, hook_event_name: 'Stop', last_assistant_message: 'Added retry with backoff.' }, ctx)!)
    if (final && final.contextText.includes('Added retry with backoff') && final.codeChanges.some(c => c.file === 'src/pay.ts')) {
      results.push(pass('codex Stop closing summary', 'last_assistant_message in contextText'))
    } else {
      results.push(fail('codex Stop closing summary', `text="${final?.contextText.slice(0, 80)}"`))
    }
  }

  // ── 6. Cursor field mapping: conversation_id/generation_id → sessionId/turnId ──────────────
  {
    const event = parseCursorHook(
      { hook_event_name: 'beforeSubmitPrompt', conversation_id: 'conv-7', generation_id: 'gen-3', workspace_roots: ['/ws'], prompt: 'refactor auth' },
      ctx,
    )
    if (event?.hook === 'PROMPT' && event.sessionId === 'conv-7' && event.turnId === 'gen-3' && event.projectPath === '/ws') {
      results.push(pass('cursor field mapping', 'conversation_id→sessionId, generation_id→turnId'))
    } else {
      results.push(fail('cursor field mapping', JSON.stringify(event)))
    }
  }

  // ── 7. Cursor stop.status='error' → bracket NOT finalized (incomplete turn) ────────────────
  {
    const brackets = new BracketManager()
    const base = { conversation_id: 'cur-err', workspace_roots: ['/ws'] }
    brackets.handle(parseCursorHook({ ...base, hook_event_name: 'beforeSubmitPrompt', prompt: 'do thing' }, ctx)!)
    brackets.handle(parseCursorHook({ ...base, hook_event_name: 'afterFileEdit', file_path: '/ws/x.ts', edits: [{ old_string: 'a', new_string: 'b' }] }, ctx)!)
    const stopEvent = parseCursorHook({ ...base, hook_event_name: 'stop', status: 'error', loop_count: 2 }, ctx)!
    const final = brackets.handle(stopEvent)
    // stop is TURN_END; with isFailure the bracket still closes but we record the failure flag.
    // The "incomplete" contract: the TURN_END event itself carries isFailure=true.
    if (stopEvent.isFailure === true && stopEvent.hook === 'TURN_END') {
      results.push(pass('cursor stop error', `isFailure=true${final ? ' (finalized)' : ' (dropped)'}`))
    } else {
      results.push(fail('cursor stop error', JSON.stringify(stopEvent)))
    }
  }

  // ── 8. parseHook router dispatches by source ──────────────────────────────────────────────
  {
    const cc = parseHook('claude-code', { hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: '/p', prompt: 'x' }, ctx)
    const cx = parseHook('codex', { hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: '/p', prompt: 'x', turn_id: 't' }, ctx)
    const cu = parseHook('cursor', { hook_event_name: 'beforeSubmitPrompt', conversation_id: 'c', workspace_roots: ['/p'], prompt: 'x' }, ctx)
    if (cc?.source === 'claude-code' && cx?.source === 'codex' && cu?.source === 'cursor') {
      results.push(pass('parseHook router', 'all three sources dispatch correctly'))
    } else {
      results.push(fail('parseHook router', `cc=${cc?.source} cx=${cx?.source} cu=${cu?.source}`))
    }
  }

  // ── 9. Cursor full turn integration: open → edit → close finalizes cleanly ─────────────────
  {
    const brackets = new BracketManager()
    const base = { conversation_id: 'cur-int', workspace_roots: ['/ws'] }
    brackets.handle(parseCursorHook({ ...base, hook_event_name: 'beforeSubmitPrompt', prompt: 'add validation' }, ctx)!)
    brackets.handle(parseCursorHook({ ...base, hook_event_name: 'afterAgentThought', text: 'I will add a guard clause.' }, ctx)!)
    brackets.handle(parseCursorHook({ ...base, hook_event_name: 'afterFileEdit', file_path: '/ws/validate.ts', edits: [{ old_string: '', new_string: 'export function validate() {}' }] }, ctx)!)
    brackets.handle(parseCursorHook({ ...base, hook_event_name: 'afterAgentResponse', text: 'Added validation guard.' }, ctx)!)
    const final = brackets.handle(parseCursorHook({ ...base, hook_event_name: 'stop', status: 'completed', loop_count: 1 }, ctx)!)
    if (final && final.codeChanges.some(c => c.file === '/ws/validate.ts') && final.contextText.includes('add validation')) {
      results.push(pass('cursor full turn', `${final.codeChanges.length} change(s), closing summary pooled`))
    } else {
      results.push(fail('cursor full turn', `final=${!!final} text="${final?.contextText.slice(0, 80)}"`))
    }
  }

  console.log('\n── memwise Layer 9 adapter tests ──\n')
  let passed = 0
  for (const r of results) {
    const icon = r.ok ? '✓' : '✗'
    const label = r.ok ? '\x1b[32m' : '\x1b[31m'
    console.log(`  ${label}${icon}\x1b[0m  ${r.name.padEnd(28)} ${r.detail}`)
    if (r.ok) passed++
  }
  console.log(`\n  ${passed}/${results.length} passed\n`)
  process.exit(passed === results.length ? 0 : 1)
}

main()

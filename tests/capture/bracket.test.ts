import { BracketManager, codeChangesFromToolEvent } from '../../src/capture/bracket.js'
import { parseClaudeCodeHook, parseCodexHook, parseCursorHook } from '../../src/adapters/index.js'
import {
  computeMessageSig,
  serializeEdits,
  worthStoringMessage,
} from '../../src/core/signature.js'
import type { CaptureEvent, CodeChange } from '../../src/core/types.js'

type TestResult = { name: string; ok: boolean; detail: string }

function pass(name: string, detail = ''): TestResult {
  return { name, ok: true, detail }
}

function fail(name: string, detail: string): TestResult {
  return { name, ok: false, detail }
}

function evt(partial: Partial<CaptureEvent> & Pick<CaptureEvent, 'hook' | 'sessionId'>): CaptureEvent {
  return {
    source: 'claude-code',
    seq: 1,
    projectPath: '/proj',
    ts: 1_700_000_000,
    ...partial,
  }
}

function main(): void {
  const results: TestResult[] = []
  const mgr = new BracketManager()

  // 1. Message close → 64-char hex sig
  mgr.handle(evt({ hook: 'PROMPT', message: 'fix race in payment', sessionId: 's1' }))
  mgr.handle(evt({ hook: 'NARRATION', message: 'Adding a mutex to processPayment', sessionId: 's1' }))
  mgr.handle(evt({ hook: 'TOOL', sessionId: 's1', toolName: 'Edit', toolInput: { file_path: 'src/processor.ts' } }))
  const msg1 = mgr.handle(evt({ hook: 'TURN_END', sessionId: 's1', message: 'Done.' }))
  if (!msg1?.sig || !/^[a-f0-9]{64}$/.test(msg1.sig)) {
    results.push(fail('signature length', `expected 64-char hex, got ${msg1?.sig}`))
  } else {
    results.push(pass('signature length', `${msg1.sig.slice(0, 12)}… (${msg1.sig.length} chars)`))
  }

  // 1b. FinalizedMessage shape — contextText pools narration + closing summary; codeChanges present
  if (!msg1?.contextText.includes('Adding a mutex')) {
    results.push(fail('contextText pools narration', `missing narration in: "${msg1?.contextText}"`))
  } else if (!msg1.contextText.includes('Done.')) {
    results.push(fail('contextText pools closing summary', `missing closing msg in: "${msg1?.contextText}"`))
  } else if (msg1.codeChanges.length !== 1 || msg1.codeChanges[0]?.file !== 'src/processor.ts') {
    results.push(fail('codeChanges in message', `expected 1 change, got ${JSON.stringify(msg1?.codeChanges)}`))
  } else {
    results.push(pass('FinalizedMessage shape', 'contextText + codeChanges correct'))
  }

  // 2. Deterministic — same inputs → identical sig
  const edits: CodeChange[] = [
    { file: 'src/processor.ts', symbol: 'processPayment', changeType: 'modified' },
  ]
  const a = computeMessageSig('fix race', edits)
  const b = computeMessageSig('fix race', edits)
  const payloadCheck = serializeEdits([
    { file: 'b.ts', symbol: 'z', changeType: 'modified' },
    { file: 'a.ts', symbol: 'a', changeType: 'added' },
  ])
  if (a !== b) {
    results.push(fail('deterministic signature', 'same inputs produced different hashes'))
  } else if (!payloadCheck.startsWith('[{"file":"a.ts"')) {
    results.push(fail('deterministic signature', 'serializeEdits sort order wrong'))
  } else {
    results.push(pass('deterministic signature', 'identical hash + sorted edits'))
  }

  // 3. Two sequential messages touching same file → parentSig chain
  const mgr2 = new BracketManager()
  mgr2.handle(evt({ hook: 'PROMPT', message: 'first change', sessionId: 's2' }))
  mgr2.handle(evt({ hook: 'TOOL', sessionId: 's2', toolName: 'Edit', toolInput: { file_path: 'src/a.ts' } }))
  const first = mgr2.handle(evt({ hook: 'TURN_END', sessionId: 's2' }))

  mgr2.handle(evt({ hook: 'PROMPT', message: 'second change', sessionId: 's2' }))
  mgr2.handle(evt({ hook: 'TOOL', sessionId: 's2', toolName: 'Edit', toolInput: { file_path: 'src/a.ts' } }))
  const second = mgr2.handle(evt({ hook: 'TURN_END', sessionId: 's2' }))

  if (!first?.sig || second?.parentSig !== first.sig) {
    results.push(fail('parentSig chain', `expected ${first?.sig}, got parentSig=${second?.parentSig}`))
  } else {
    results.push(pass('parentSig chain', 'second.parentSig === first.sig'))
  }

  // 3b. Cross-message lineage via touchedFiles (plan→execution)
  const mgr2b = new BracketManager()
  mgr2b.handle(evt({ hook: 'PROMPT', message: 'design the plan', sessionId: 's2b' }))
  mgr2b.handle(evt({ hook: 'TOOL', sessionId: 's2b', toolName: 'Write', toolInput: { file_path: 'plan.md', content: 'Build the payment service' } }))
  const planMsg = mgr2b.handle(evt({ hook: 'TURN_END', sessionId: 's2b' }))

  mgr2b.handle(evt({ hook: 'PROMPT', message: 'execute the plan', sessionId: 's2b' }))
  // Agent reads plan.md (file_access — caller must call addTouchedFile; simulate by calling it)
  mgr2b.addTouchedFile(evt({ hook: 'TOOL', sessionId: 's2b', toolName: 'Read', toolInput: { file_path: 'plan.md' } }))
  mgr2b.handle(evt({ hook: 'TOOL', sessionId: 's2b', toolName: 'Write', toolInput: { file_path: 'src/payment.ts', content: 'class PaymentService {}' } }))
  const execMsg = mgr2b.handle(evt({ hook: 'TURN_END', sessionId: 's2b' }))

  if (!planMsg?.sig || execMsg?.parentSig !== planMsg.sig) {
    results.push(fail('touchedFiles parent_sig', `execution should link to plan: planSig=${planMsg?.sig?.slice(0,8)}, execParent=${execMsg?.parentSig?.slice(0,8)}`))
  } else {
    results.push(pass('touchedFiles parent_sig', 'execution→plan linked via read of plan.md'))
  }

  // 4. Text-only ≥40 chars → worthStoring true
  if (!worthStoringMessage([], 'chose optimistic locking due to low contention')) {
    results.push(fail('worthStoring long text', 'expected true for ≥40 chars'))
  } else {
    results.push(pass('worthStoring long text', '≥40 chars → true'))
  }

  // 5. Text-only <40 chars → worthStoring false
  if (worthStoringMessage([], 'ok thanks')) {
    results.push(fail('worthStoring short text', 'expected false for <40 chars'))
  } else {
    results.push(pass('worthStoring short text', '<40 chars → false'))
  }

  // 6. Code changes → always worthStoring
  if (!worthStoringMessage([{ file: 'x.ts', symbol: 'x', changeType: 'modified' }], '')) {
    results.push(fail('worthStoring code-only', 'code changes should always store'))
  } else {
    results.push(pass('worthStoring code-only', 'code changes → true'))
  }

  // 7. Multi-intent prompt → ONE message, ALL changes pooled, contextText has both narrations
  const mgr3 = new BracketManager()
  mgr3.handle(evt({ hook: 'PROMPT', message: 'fix payment AND fix cart', sessionId: 's3' }))
  mgr3.handle(evt({ hook: 'NARRATION', message: 'First I will fix the payment processor', sessionId: 's3' }))
  mgr3.handle(evt({ hook: 'TOOL', sessionId: 's3', toolName: 'Edit', toolInput: { file_path: 'src/payment.ts' } }))
  mgr3.handle(evt({ hook: 'NARRATION', message: 'Now fixing the cart total calculation', sessionId: 's3' }))
  mgr3.handle(evt({ hook: 'TOOL', sessionId: 's3', toolName: 'Edit', toolInput: { file_path: 'src/cart.ts' } }))
  const multi = mgr3.handle(evt({ hook: 'TURN_END', sessionId: 's3' }))
  const multiFiles = multi?.codeChanges.map(c => c.file).sort().join(',')
  if (multiFiles !== 'src/cart.ts,src/payment.ts') {
    results.push(fail('multi-intent pooled changes', `expected both files, got: ${multiFiles}`))
  } else if (!multi?.contextText.includes('payment processor') || !multi.contextText.includes('cart total')) {
    results.push(fail('multi-intent pooled context', `both narrations should be in contextText: "${multi?.contextText.slice(0,100)}"...`))
  } else {
    results.push(pass('multi-segment split', `ONE message, both changes + both narrations pooled`))
  }

  // 7b. REGRESSION: CC keying — narration with turn_id still routes to correct bracket
  const mgr3b = new BracketManager()
  mgr3b.handle(evt({ hook: 'PROMPT', sessionId: 's3b', message: 'fix payment service and cart patch' }))
  mgr3b.handle(evt({ hook: 'NARRATION', sessionId: 's3b', turnId: 'T', message: 'First, fixing the payment service' }))
  mgr3b.handle(evt({ hook: 'TOOL', sessionId: 's3b', toolName: 'Edit', toolInput: { file_path: 'src/payment.ts' } }))
  mgr3b.handle(evt({ hook: 'NARRATION', sessionId: 's3b', turnId: 'T', message: 'Now the buy-from-cart patch' }))
  mgr3b.handle(evt({ hook: 'TOOL', sessionId: 's3b', toolName: 'Edit', toolInput: { file_path: 'src/cart.ts' } }))
  const keyed = mgr3b.handle(evt({ hook: 'TURN_END', sessionId: 's3b', message: 'Done.' }))
  const keyedFiles = keyed?.codeChanges.map(c => c.file).sort().join(',')
  if (keyedFiles !== 'src/cart.ts,src/payment.ts') {
    results.push(fail('CC turn_id keying', `both files should be in ONE message, got: ${keyedFiles}`))
  } else if (!keyed?.contextText.includes('payment service') || !keyed.contextText.includes('buy-from-cart')) {
    results.push(fail('CC turn_id keying context', `missing narration in contextText`))
  } else {
    results.push(pass('CC turn_id keying', 'turn_id on narration only → ONE message, both changes'))
  }

  // 8. contextText is anchored on the PROMPT (spine vector includes the user's ask)
  const mgrP = new BracketManager()
  mgrP.handle(evt({ hook: 'PROMPT', sessionId: 'sp', message: 'refactor the auth middleware for clarity' }))
  mgrP.handle(evt({ hook: 'TOOL', sessionId: 'sp', toolName: 'Edit', toolInput: { file_path: 'src/auth.ts' } }))
  const pMsg = mgrP.handle(evt({ hook: 'TURN_END', sessionId: 'sp' }))
  if (!pMsg?.contextText.includes('refactor the auth middleware')) {
    results.push(fail('prompt-anchored context', `contextText must include the prompt: "${pMsg?.contextText}"`))
  } else {
    results.push(pass('prompt-anchored context', 'contextText leads with the user prompt'))
  }

  // Adapter fixtures
  const ctx = { seq: 1 }

  const cc = parseClaudeCodeHook(
    {
      hook_event_name: 'PostToolUse',
      session_id: 'abc',
      cwd: '/repo',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/main.ts' },
      tool_response: { filePath: 'src/main.ts', success: true },
    },
    ctx,
  )
  if (!cc || cc.hook !== 'TOOL' || cc.sessionId !== 'abc' || cc.toolInput?.file_path !== 'src/main.ts' || (cc.toolResponse as { success?: boolean })?.success !== true) {
    results.push(fail('claude-code adapter', JSON.stringify(cc)))
  } else {
    results.push(pass('claude-code adapter', 'PostToolUse → TOOL, tool_response mapped'))
  }

  const ccStop = parseClaudeCodeHook(
    {
      hook_event_name: 'Stop',
      session_id: 'abc',
      cwd: '/repo',
      stop_hook_active: false,
      last_assistant_message: "I've added the mutex.",
    },
    ctx,
  )
  if (ccStop?.hook !== 'TURN_END' || ccStop.message !== "I've added the mutex.") {
    results.push(fail('claude-code Stop message', JSON.stringify(ccStop)))
  } else {
    results.push(pass('claude-code Stop message', 'Stop → last_assistant_message captured'))
  }

  const midChunk = parseClaudeCodeHook(
    { hook_event_name: 'MessageDisplay', session_id: 'abc', cwd: '/repo',
      message_id: 'msg-1', turn_id: 'turn-1', index: 0, delta: 'Now editing the ', final: false },
    ctx,
  )
  if (midChunk !== null) {
    results.push(fail('claude-code narration mid-chunk', `expected null for non-final, got ${JSON.stringify(midChunk)}`))
  } else {
    results.push(pass('claude-code narration mid-chunk', 'non-final delta → null'))
  }

  const finalChunk = parseClaudeCodeHook(
    { hook_event_name: 'MessageDisplay', session_id: 'abc', cwd: '/repo',
      message_id: 'msg-1', turn_id: 'turn-1', index: 1, delta: 'payment module', final: true },
    ctx,
  )
  if (finalChunk?.hook !== 'NARRATION' || finalChunk.message !== 'Now editing the payment module') {
    results.push(fail('claude-code narration final-chunk', `expected assembled text, got ${JSON.stringify(finalChunk)}`))
  } else {
    results.push(pass('claude-code narration final-chunk', `MessageDisplay delta assembled → "${finalChunk.message}"`))
  }

  const cursor = parseCursorHook(
    { hook_event_name: 'beforeSubmitPrompt', conversation_id: 'conv-1', generation_id: 'gen-1',
      workspace_roots: ['/workspace'], prompt: 'implement checkout' },
    ctx,
  )
  if (!cursor || cursor.hook !== 'PROMPT' || cursor.sessionId !== 'conv-1' || cursor.turnId !== 'gen-1') {
    results.push(fail('cursor adapter', JSON.stringify(cursor)))
  } else {
    results.push(pass('cursor adapter', 'beforeSubmitPrompt → PROMPT'))
  }

  const cursorThought = parseCursorHook(
    { hook_event_name: 'afterAgentThought', conversation_id: 'conv-1', generation_id: 'gen-1',
      workspace_roots: ['/workspace'], text: 'I will refactor the cart service next' },
    ctx,
  )
  if (!cursorThought || cursorThought.hook !== 'NARRATION') {
    results.push(fail('cursor narration', JSON.stringify(cursorThought)))
  } else {
    results.push(pass('cursor narration', 'afterAgentThought → NARRATION'))
  }

  const cursorMod = parseCursorHook(
    { hook_event_name: 'afterFileEdit', conversation_id: 'c', generation_id: 'g',
      file_path: 'src/cart.ts', edits: [{ old_string: 'old total', new_string: 'new total' }] },
    ctx,
  )
  const cursorNew = parseCursorHook(
    { hook_event_name: 'afterFileEdit', conversation_id: 'c', generation_id: 'g',
      file_path: 'src/feature.ts', edits: [{ old_string: '', new_string: 'brand new file' }] },
    ctx,
  )
  // src/cart.ts / src/feature.ts don't exist on disk → file-level fallback, but changeType still inferred
  const modChange = cursorMod && codeChangesFromToolEvent(cursorMod).changes[0]
  const newChange = cursorNew && codeChangesFromToolEvent(cursorNew).changes[0]
  if (modChange?.changeType !== 'modified' || newChange?.changeType !== 'added') {
    results.push(fail('cursor changeType', `mod=${modChange?.changeType}, new=${newChange?.changeType}`))
  } else {
    results.push(pass('cursor changeType', 'non-empty old_string → modified; empty → added'))
  }

  // Cursor closing segment: ONE message with all files, closing summary in contextText
  const cur = (raw: Record<string, unknown>) => parseCursorHook(raw, ctx)!
  const base = { conversation_id: 'cc', generation_id: 'g' }
  const mgrCur = new BracketManager()
  mgrCur.handle(cur({ ...base, hook_event_name: 'beforeSubmitPrompt', prompt: 'fix payment and cart' }))
  mgrCur.handle(cur({ ...base, hook_event_name: 'afterAgentThought', text: 'First, fix the payment service' }))
  mgrCur.handle(cur({ ...base, hook_event_name: 'afterFileEdit', file_path: 'src/payment.ts', edits: [{ old_string: 'a', new_string: 'b' }] }))
  mgrCur.handle(cur({ ...base, hook_event_name: 'afterAgentThought', text: 'Now the buy-from-cart patch' }))
  mgrCur.handle(cur({ ...base, hook_event_name: 'afterFileEdit', file_path: 'src/cart.ts', edits: [{ old_string: 'a', new_string: 'b' }] }))
  mgrCur.handle(cur({ ...base, hook_event_name: 'afterAgentResponse', text: 'Done — patched the payment service and the cart buy flow.' }))
  const curMsg = mgrCur.handle(cur({ ...base, hook_event_name: 'stop', status: 'completed' }))
  const curFiles = curMsg?.codeChanges.map(c => c.file).sort().join(' | ')
  if (curFiles !== 'src/cart.ts | src/payment.ts') {
    results.push(fail('cursor closing segment', `expected both files in ONE message, got: ${curFiles}`))
  } else if (!curMsg?.contextText.includes('Done — patched')) {
    results.push(fail('cursor closing segment', `closing summary not in contextText: "${curMsg?.contextText.slice(0, 100)}"...`))
  } else {
    results.push(pass('cursor closing segment', 'ONE message; both files + closing summary in contextText'))
  }

  const codex = parseCodexHook(
    { hook_event_name: 'UserPromptSubmit', session_id: 'codex-1', turn_id: 'turn-9', cwd: '/repo', prompt: 'run tests' },
    ctx,
  )
  if (!codex || codex.hook !== 'PROMPT' || codex.turnId !== 'turn-9') {
    results.push(fail('codex adapter', JSON.stringify(codex)))
  } else {
    results.push(pass('codex adapter', 'UserPromptSubmit → PROMPT + turnId'))
  }

  const unknownCC = parseClaudeCodeHook({ hook_event_name: 'SubagentStart', session_id: 'x', cwd: '/' }, ctx)
  const unknownCursor = parseCursorHook({ hook_event_name: 'FileChanged', session_id: 'x', cwd: '/' }, ctx)
  const unknownCodex = parseCodexHook({ hook_event_name: 'StopFailure', session_id: 'x', cwd: '/' }, ctx)
  if (unknownCC !== null || unknownCursor !== null || unknownCodex !== null) {
    results.push(fail('unknown hooks return null', 'expected null for all unknown hook names'))
  } else {
    results.push(pass('unknown hooks return null', 'SubagentStart/FileChanged/StopFailure → null'))
  }

  console.log('\n── memwise Layer 2 bracket tests ──\n')
  let passed = 0
  for (const r of results) {
    const icon = r.ok ? '✓' : '✗'
    const label = r.ok ? '\x1b[32m' : '\x1b[31m'
    console.log(`  ${label}${icon}\x1b[0m  ${r.name.padEnd(30)} ${r.detail}`)
    if (r.ok) passed++
  }
  console.log(`\n  ${passed}/${results.length} passed\n`)
  process.exit(passed === results.length ? 0 : 1)
}

main()

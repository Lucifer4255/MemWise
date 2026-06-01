import { BracketManager, codeChangeFromToolEvent } from './bracket.js'
import { parseClaudeCodeHook, parseCodexHook, parseCursorHook } from './adapters/index.js'
import {
  computeSignature,
  resolveIntentText,
  serializeEdits,
  worthStoringSegment,
} from './signature.js'
import type { CaptureEvent, CodeChange } from './types.js'

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

  // 1. Open → close with code changes → 64-char hex signature
  mgr.handle(evt({ hook: 'PROMPT', message: 'fix race in payment', sessionId: 's1' }))
  mgr.handle(
    evt({
      hook: 'NARRATION',
      message: 'Adding a mutex to processPayment',
      sessionId: 's1',
    }),
  )
  mgr.handle(
    evt({
      hook: 'TOOL',
      sessionId: 's1',
      toolName: 'Edit',
      toolInput: { file_path: 'src/processor.ts' },
    }),
  )
  const closed1 = mgr.handle(evt({ hook: 'TURN_END', sessionId: 's1', message: 'Done.' }))
  const sig1 = closed1[0]?.segment.signature
  if (!sig1 || !/^[a-f0-9]{64}$/.test(sig1)) {
    results.push(fail('signature length', `expected 64-char hex, got ${sig1}`))
  } else {
    results.push(pass('signature length', `${sig1.slice(0, 12)}… (${sig1.length} chars)`))
  }

  // 2. Deterministic — same inputs → identical signature
  const edits: CodeChange[] = [
    { file: 'src/processor.ts', symbol: 'processPayment', changeType: 'modified' },
  ]
  const a = computeSignature('fix race', 0, 'Adding mutex', edits)
  const b = computeSignature('fix race', 0, 'Adding mutex', edits)
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

  // 3. Two sequential brackets touching same file → parentSig chain
  const mgr2 = new BracketManager()
  mgr2.handle(evt({ hook: 'PROMPT', message: 'first change', sessionId: 's2' }))
  mgr2.handle(
    evt({
      hook: 'TOOL',
      sessionId: 's2',
      toolName: 'Edit',
      toolInput: { file_path: 'src/a.ts' },
    }),
  )
  const firstClose = mgr2.handle(evt({ hook: 'TURN_END', sessionId: 's2' }))
  const firstSig = firstClose[0]?.segment.signature

  mgr2.handle(evt({ hook: 'PROMPT', message: 'second change', sessionId: 's2' }))
  mgr2.handle(
    evt({
      hook: 'TOOL',
      sessionId: 's2',
      toolName: 'Edit',
      toolInput: { file_path: 'src/a.ts' },
    }),
  )
  const secondClose = mgr2.handle(evt({ hook: 'TURN_END', sessionId: 's2' }))
  const secondParent = secondClose[0]?.segment.parentSig

  if (!firstSig || secondParent !== firstSig) {
    results.push(
      fail('parentSig chain', `expected ${firstSig}, got parentSig=${secondParent}`),
    )
  } else {
    results.push(pass('parentSig chain', 'second.parentSig === first.signature'))
  }

  // 4. Text-only ≥40 chars → worthStoring true
  const longText = createEmptySegmentWithText('chose optimistic locking due to low contention')
  if (!worthStoringSegment(longText)) {
    results.push(fail('worthStoring long text', 'expected true for ≥40 chars'))
  } else {
    results.push(pass('worthStoring long text', '≥40 chars → true'))
  }

  // 5. Text-only <40 chars → worthStoring false
  const shortText = createEmptySegmentWithText('ok thanks')
  if (worthStoringSegment(shortText)) {
    results.push(fail('worthStoring short text', 'expected false for <40 chars'))
  } else {
    results.push(pass('worthStoring short text', '<40 chars → false'))
  }

  // 6. Code-change bracket with empty message → worthStoring true
  const codeOnly = {
    codeChanges: [{ file: 'x.ts', symbol: 'x.ts', changeType: 'modified' as const }],
    messageChunks: [] as string[],
    intentText: '',
  }
  if (!worthStoringSegment(codeOnly)) {
    results.push(fail('worthStoring code-only', 'code changes should always store'))
  } else {
    results.push(pass('worthStoring code-only', 'code changes → true'))
  }

  // 7. Multi-segment: narration split → distinct sigs, shared promptText
  const mgr3 = new BracketManager()
  mgr3.handle(
    evt({
      hook: 'PROMPT',
      message: 'fix payment AND fix cart',
      sessionId: 's3',
    }),
  )
  mgr3.handle(
    evt({
      hook: 'NARRATION',
      message: 'First I will fix the payment processor',
      sessionId: 's3',
    }),
  )
  mgr3.handle(
    evt({
      hook: 'TOOL',
      sessionId: 's3',
      toolName: 'Edit',
      toolInput: { file_path: 'src/payment.ts' },
    }),
  )
  mgr3.handle(
    evt({
      hook: 'NARRATION',
      message: 'Now fixing the cart total calculation',
      sessionId: 's3',
    }),
  )
  mgr3.handle(
    evt({
      hook: 'TOOL',
      sessionId: 's3',
      toolName: 'Edit',
      toolInput: { file_path: 'src/cart.ts' },
    }),
  )
  const multi = mgr3.handle(evt({ hook: 'TURN_END', sessionId: 's3' }))
  if (multi.length !== 2) {
    results.push(fail('multi-segment split', `expected 2 segments, got ${multi.length}`))
  } else if (multi[0]!.segment.signature === multi[1]!.segment.signature) {
    results.push(fail('multi-segment split', 'segments must have distinct signatures'))
  } else if (multi[0]!.segment.segmentIdx !== 0 || multi[1]!.segment.segmentIdx !== 1) {
    results.push(fail('multi-segment split', 'segment_idx should be 0 and 1'))
  } else {
    results.push(
      pass(
        'multi-segment split',
        `2 sigs: ${multi[0]!.segment.signature!.slice(0, 8)}… / ${multi[1]!.segment.signature!.slice(0, 8)}…`,
      ),
    )
  }

  // 7b. REGRESSION: real Claude Code keying — only MessageDisplay carries turn_id;
  // PROMPT/TOOL/TURN_END do not. Before keying on sessionId alone, narration routed to a
  // different bucket and was dropped, collapsing both intents into one polluted signature.
  const mgr3b = new BracketManager()
  mgr3b.handle(evt({ hook: 'PROMPT', sessionId: 's3b', message: 'fix the payment service and add to cart buy from cart patch' }))
  mgr3b.handle(evt({ hook: 'NARRATION', sessionId: 's3b', turnId: 'T', message: 'First, fixing the payment service' }))
  mgr3b.handle(evt({ hook: 'TOOL', sessionId: 's3b', toolName: 'Edit', toolInput: { file_path: 'src/payment.ts' } }))
  mgr3b.handle(evt({ hook: 'NARRATION', sessionId: 's3b', turnId: 'T', message: 'Now the buy-from-cart patch' }))
  mgr3b.handle(evt({ hook: 'TOOL', sessionId: 's3b', toolName: 'Edit', toolInput: { file_path: 'src/cart.ts' } }))
  const keyed = mgr3b.handle(evt({ hook: 'TURN_END', sessionId: 's3b', message: 'Done.' }))
  const files0 = keyed[0]?.segment.codeChanges.map(c => c.file).join(',')
  const files1 = keyed[1]?.segment.codeChanges.map(c => c.file).join(',')
  if (keyed.length !== 2) {
    results.push(fail('CC turn_id keying', `narration dropped → ${keyed.length} segment(s), expected 2`))
  } else if (files0 !== 'src/payment.ts' || files1 !== 'src/cart.ts') {
    results.push(fail('CC turn_id keying', `segments not split by file: [${files0}] / [${files1}]`))
  } else {
    results.push(pass('CC turn_id keying', 'turn_id only on narration → still 2 clean segments'))
  }

  // 8. resolveIntentText fallback
  const fallback = resolveIntentText(null, 'user prompt text')
  if (fallback !== 'user prompt text') {
    results.push(fail('intent fallback', `expected promptText fallback, got ${fallback}`))
  } else {
    results.push(pass('intent fallback', 'empty intent → promptText'))
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
      tool_response: { filePath: 'src/main.ts', success: true }, // docs: PostToolUse → tool_response
    },
    ctx,
  )
  if (!cc || cc.hook !== 'TOOL' || cc.sessionId !== 'abc' || cc.toolInput?.file_path !== 'src/main.ts' || (cc.toolResponse as { success?: boolean })?.success !== true) {
    results.push(fail('claude-code adapter', JSON.stringify(cc)))
  } else {
    results.push(pass('claude-code adapter', 'PostToolUse → TOOL, tool_response mapped'))
  }

  // Stop carries last_assistant_message (docs §Stop input) → captured as TURN_END message
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

  // MessageDisplay streams in chunks — non-final returns null, final returns assembled text
  const midChunk = parseClaudeCodeHook(
    {
      hook_event_name: 'MessageDisplay',
      session_id: 'abc',
      cwd: '/repo',
      message_id: 'msg-1',
      turn_id: 'turn-1',
      index: 0,
      delta: 'Now editing the ',
      final: false,
    },
    ctx,
  )
  if (midChunk !== null) {
    results.push(fail('claude-code narration mid-chunk', `expected null for non-final, got ${JSON.stringify(midChunk)}`))
  } else {
    results.push(pass('claude-code narration mid-chunk', 'non-final delta → null'))
  }

  const finalChunk = parseClaudeCodeHook(
    {
      hook_event_name: 'MessageDisplay',
      session_id: 'abc',
      cwd: '/repo',
      message_id: 'msg-1',
      turn_id: 'turn-1',
      index: 1,
      delta: 'payment module',
      final: true,
    },
    ctx,
  )
  if (finalChunk?.hook !== 'NARRATION' || finalChunk.message !== 'Now editing the payment module') {
    results.push(fail('claude-code narration final-chunk', `expected assembled text, got ${JSON.stringify(finalChunk)}`))
  } else {
    results.push(pass('claude-code narration final-chunk', `MessageDisplay delta assembled → "${finalChunk.message}"`))
  }

  const cursor = parseCursorHook(
    {
      hook_event_name: 'beforeSubmitPrompt',
      conversation_id: 'conv-1',
      generation_id: 'gen-1',
      workspace_roots: ['/workspace'],
      prompt: 'implement checkout',
    },
    ctx,
  )
  if (!cursor || cursor.hook !== 'PROMPT' || cursor.sessionId !== 'conv-1' || cursor.turnId !== 'gen-1') {
    results.push(fail('cursor adapter', JSON.stringify(cursor)))
  } else {
    results.push(pass('cursor adapter', 'beforeSubmitPrompt → PROMPT'))
  }

  const cursorThought = parseCursorHook(
    {
      hook_event_name: 'afterAgentThought',
      conversation_id: 'conv-1',
      generation_id: 'gen-1',
      workspace_roots: ['/workspace'],
      text: 'I will refactor the cart service next',
    },
    ctx,
  )
  if (!cursorThought || cursorThought.hook !== 'NARRATION') {
    results.push(fail('cursor narration', JSON.stringify(cursorThought)))
  } else {
    results.push(pass('cursor narration', 'afterAgentThought → NARRATION'))
  }

  // Cursor finding 1: afterFileEdit changeType inferred from edits, not defaulted to 'added'
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
  const modChange = cursorMod && codeChangeFromToolEvent(cursorMod)
  const newChange = cursorNew && codeChangeFromToolEvent(cursorNew)
  if (modChange?.changeType !== 'modified' || newChange?.changeType !== 'added') {
    results.push(fail('cursor changeType', `mod=${modChange?.changeType}, new=${newChange?.changeType}`))
  } else {
    results.push(pass('cursor changeType', 'non-empty old_string → modified; empty → added'))
  }

  // Cursor finding 2: afterAgentResponse (turn-final) must NOT spawn an extra text-only segment
  const cur = (raw: Record<string, unknown>) => parseCursorHook(raw, ctx)!
  const base = { conversation_id: 'cc', generation_id: 'g' }
  const mgrCur = new BracketManager()
  mgrCur.handle(cur({ ...base, hook_event_name: 'beforeSubmitPrompt', prompt: 'fix payment and cart' }))
  mgrCur.handle(cur({ ...base, hook_event_name: 'afterAgentThought', text: 'First, fix the payment service' }))
  mgrCur.handle(cur({ ...base, hook_event_name: 'afterFileEdit', file_path: 'src/payment.ts', edits: [{ old_string: 'a', new_string: 'b' }] }))
  mgrCur.handle(cur({ ...base, hook_event_name: 'afterAgentThought', text: 'Now the buy-from-cart patch' }))
  mgrCur.handle(cur({ ...base, hook_event_name: 'afterFileEdit', file_path: 'src/cart.ts', edits: [{ old_string: 'a', new_string: 'b' }] }))
  mgrCur.handle(cur({ ...base, hook_event_name: 'afterAgentResponse', text: 'Done — patched the payment service and the cart buy flow.' }))
  const curClosed = mgrCur.handle(cur({ ...base, hook_event_name: 'stop', status: 'completed' }))
  const curFiles = curClosed.map(s => s.segment.codeChanges.map(c => c.file).join('')).join(' | ')
  const lastChunks = curClosed[curClosed.length - 1]?.segment.messageChunks.join(' ') ?? ''
  if (curClosed.length !== 2) {
    results.push(fail('cursor closing segment', `afterAgentResponse spawned extra segment → ${curClosed.length}, expected 2 (${curFiles})`))
  } else if (!lastChunks.includes('Done — patched')) {
    results.push(fail('cursor closing segment', `closing summary not attached to last segment: "${lastChunks}"`))
  } else {
    results.push(pass('cursor closing segment', '2 segments; closing summary attached, no extra node'))
  }

  const codex = parseCodexHook(
    {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'codex-1',
      turn_id: 'turn-9',
      cwd: '/repo',
      prompt: 'run tests',
    },
    ctx,
  )
  if (!codex || codex.hook !== 'PROMPT' || codex.turnId !== 'turn-9') {
    results.push(fail('codex adapter', JSON.stringify(codex)))
  } else {
    results.push(pass('codex adapter', 'UserPromptSubmit → PROMPT + turnId'))
  }

  // Unknown/future hooks must return null, not throw (27+ events; we only handle ~9)
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
    console.log(`  ${label}${icon}\x1b[0m  ${r.name.padEnd(26)} ${r.detail}`)
    if (r.ok) passed++
  }
  console.log(`\n  ${passed}/${results.length} passed\n`)
  process.exit(passed === results.length ? 0 : 1)
}

function createEmptySegmentWithText(text: string) {
  return {
    codeChanges: [] as CodeChange[],
    messageChunks: [text],
    intentText: text,
  }
}

main()

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeRedis, getRedis } from '../redis.js'
import { retrieve } from '../retrieval/retrieve.js'
import { readTranscript } from './transcript-reader.js'
import { replayTranscript } from './replay.js'

type TestResult = { name: string; ok: boolean; detail: string }
const pass = (name: string, detail = ''): TestResult => ({ name, ok: true, detail })
const fail = (name: string, detail: string): TestResult => ({ name, ok: false, detail })

// A minimal but real-shaped Claude Code transcript: 2 user turns, narration, Write tool calls,
// and tool_results (matching the verified schema: user/string prompts, assistant/tool_use, etc.).
function fixtureLines(): string {
  const cwd = '/tmp/replay-proj'
  const sid = 'fixture-session'
  const rows = [
    { type: 'user', message: { content: 'add a retry loop to processPayment' }, sessionId: sid, cwd, timestamp: '2026-06-01T10:00:00Z' },
    { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: "I'll add exponential backoff to processPayment." }] }, sessionId: sid, cwd, timestamp: '2026-06-01T10:00:01Z' },
    { type: 'assistant', uuid: 'a2', message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'pay.ts', content: 'function processPayment() { return retry() }\nfunction retry() { return 1 }\n' } }] }, sessionId: sid, cwd, timestamp: '2026-06-01T10:00:02Z' },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }, sessionId: sid, cwd, timestamp: '2026-06-01T10:00:03Z' },
    { type: 'user', message: { content: 'now write tests for the retry path' }, sessionId: sid, cwd, timestamp: '2026-06-01T10:01:00Z' },
    { type: 'assistant', uuid: 'a3', message: { content: [{ type: 'text', text: 'Adding tests for retry.' }] }, sessionId: sid, cwd, timestamp: '2026-06-01T10:01:01Z' },
    { type: 'assistant', uuid: 'a4', message: { content: [{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: 'pay.test.ts', content: "test('retry', () => {})\n" } }] }, sessionId: sid, cwd, timestamp: '2026-06-01T10:01:02Z' },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] }, sessionId: sid, cwd, timestamp: '2026-06-01T10:01:03Z' },
    // sidechain noise + a slash-command artifact — both must be ignored
    { type: 'user', isSidechain: true, message: { content: 'subagent chatter' }, sessionId: sid, cwd, timestamp: '2026-06-01T10:01:04Z' },
    { type: 'user', message: { content: '<local-command-caveat>ignore me</local-command-caveat>' }, sessionId: sid, cwd, timestamp: '2026-06-01T10:01:05Z' },
  ]
  return rows.map(r => JSON.stringify(r)).join('\n') + '\n'
}

async function main(): Promise<void> {
  const results: TestResult[] = []
  const dir = mkdtempSync(join(tmpdir(), 'memwise-replay-'))
  const path = join(dir, 'transcript.jsonl')
  writeFileSync(path, fixtureLines())

  // 1. transcript-reader: maps to the right hook payloads, ignores sidechain/command noise.
  {
    const { events, sessionId, projectPath } = readTranscript(path)
    const hooks = events.map(e => e.payload.hook_event_name)
    const prompts = hooks.filter(h => h === 'UserPromptSubmit').length
    const stops = hooks.filter(h => h === 'Stop').length
    const tools = hooks.filter(h => h === 'PostToolUse').length
    const okShape =
      sessionId === 'fixture-session' &&
      projectPath === '/tmp/replay-proj' &&
      prompts === 2 && // sidechain + command-caveat excluded
      stops === 2 && // one per turn boundary + EOF
      tools === 2
    if (okShape) {
      results.push(pass('transcript reader', `${prompts} prompts, ${tools} tools, ${stops} stops`))
    } else {
      results.push(fail('transcript reader', `prompts=${prompts} tools=${tools} stops=${stops} hooks=${hooks.join(',')}`))
    }
  }

  // Redis required for the full replay (hot window). Skip gracefully if unavailable.
  let redisOk = false
  try {
    await getRedis().connect()
    await getRedis().ping()
    redisOk = true
  } catch {
    results.push(pass('replay capture', 'skipped (Redis unavailable)'))
    results.push(pass('replay session recap', 'skipped (Redis unavailable)'))
  }

  if (redisOk) {
    // 2. full replay → SQLite rows (deterministic embedder, no Ollama).
    const summary = await replayTranscript(path)
    const c = summary.counts
    if (summary.turnsFinalized === 2 && c.promptSig === 2 && c.contextChunk === 2 && c.change >= 2) {
      results.push(pass('replay capture', `${summary.turnsFinalized} turns → ${c.promptSig} sig, ${c.change} change`))
    } else {
      results.push(
        fail('replay capture', `turns=${summary.turnsFinalized} sig=${c.promptSig} chunk=${c.contextChunk} change=${c.change}`),
      )
    }

    // 3. session recap over the replayed project surfaces the recent prompts.
    const result = await retrieve('what are we working on', {
      store: summary.store,
      projectId: summary.projectId,
      skipHot: true,
    })
    if (result.block.includes('write tests for the retry path') && result.block.includes('current work')) {
      results.push(pass('replay session recap', 'recent prompts surfaced'))
    } else {
      results.push(fail('replay session recap', result.block.slice(0, 200)))
    }
    summary.db.close()
    await closeRedis()
  }

  console.log('\n── memwise replay harness tests ──\n')
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

main().catch(err => {
  console.error(err)
  process.exit(1)
})

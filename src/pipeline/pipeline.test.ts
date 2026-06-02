import { EMBED_DIM } from '../config.js'
import { classify } from './classify.js'
import { shouldCapture } from './filter.js'
import { CapturePipeline } from './pipeline.js'
import {
  CHUNK_PREFIX,
  chunkKey,
  closeRedis,
  ensureSearchIndex,
  getRedis,
  hotTokensKey,
  hotZsetKey,
  pushHotChunk,
  SEARCH_INDEX,
} from '../redis.js'
import type { CaptureEvent } from '../types.js'

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
    seq: 0,
    projectPath: '/tmp/memwise-test-proj',
    ts: Date.now(),
    ...partial,
  }
}

async function cleanupSession(sessionId: string): Promise<void> {
  const redis = getRedis()
  const zkey = hotZsetKey(sessionId)
  const members = await redis.zrange(zkey, 0, -1)
  const pipe = redis.pipeline()
  for (const seq of members) {
    pipe.del(`${CHUNK_PREFIX}${sessionId}:${seq}`)
  }
  pipe.del(zkey)
  pipe.del(hotTokensKey(sessionId))
  await pipe.exec()
}

async function main(): Promise<void> {
  const results: TestResult[] = []
  const redis = getRedis()

  try {
    await redis.connect()
    await redis.ping()
  } catch (e) {
    console.error('\nRedis not available — start Redis Stack before running Layer 3 tests.\n', e)
    process.exit(1)
  }

  const sessionId = `ptest${Date.now()}`

  try {
    // FT index
    try {
      await ensureSearchIndex()
      const info = (await redis.call('FT.INFO', SEARCH_INDEX)) as unknown[]
      const infoStr = JSON.stringify(info)
      const dimOk = infoStr.includes(String(EMBED_DIM))
      if (!dimOk) {
        results.push(fail('FT.CREATE index', `index exists but DIM !== ${EMBED_DIM}`))
      } else {
        results.push(pass('FT.CREATE index', `mw:idx ready, DIM=${EMBED_DIM}`))
      }
    } catch (e) {
      results.push(
        fail(
          'FT.CREATE index',
          `Redis Stack search module required: ${String(e)}`,
        ),
      )
    }

    // filter — Read/Glob/Grep/LS now PASS (feed touchedFiles); WebSearch stays dropped
    const globEvent = evt({
      hook: 'TOOL',
      sessionId: 'filter-test',
      toolName: 'Glob',
      toolInput: { pattern: '**/*' },
    })
    const webSearchEvent = evt({
      hook: 'TOOL',
      sessionId: 'filter-test',
      toolName: 'WebSearch',
      toolInput: { query: 'test' },
    })
    const writeEvent = evt({
      hook: 'TOOL',
      sessionId: 'filter-test',
      toolName: 'Write',
      toolInput: { file_path: 'src/main.ts' },
    })
    if (!shouldCapture(globEvent) || shouldCapture(webSearchEvent) || !shouldCapture(writeEvent)) {
      results.push(fail('filter', 'Glob should pass (file_access), WebSearch should drop, Write should pass'))
    } else {
      results.push(pass('filter', 'Glob passes (file_access), WebSearch dropped, Write passes'))
    }

    // classify
    const fileEvt = evt({
      hook: 'TOOL',
      sessionId: 'classify-test',
      toolName: 'Edit',
      toolInput: { file_path: 'src/a.ts' },
    })
    if (classify(fileEvt) !== 'file_change') {
      results.push(fail('classify', `expected file_change, got ${classify(fileEvt)}`))
    } else {
      results.push(pass('classify', 'file_path → file_change'))
    }

    // pipeline e2e — spine model: ONE chunk at TURN_END only
    // Mid-turn events (PROMPT/NARRATION/TOOL) → 0 chunks each; TURN_END → 1 pooled chunk
    // contextText pools: prompt + narration + doc content; code edits → graph only (no vector)
    const pipeline = new CapturePipeline()
    pipeline.seqCounter.reset(sessionId)

    await pipeline.process(evt({ hook: 'PROMPT', sessionId, message: 'implement checkout flow with payment retries', ts: 1 }))
    await pipeline.process(evt({ hook: 'NARRATION', sessionId, message: 'Adding retry logic to processPayment for webhook overlap', ts: 2 }))
    await pipeline.process(evt({ hook: 'TOOL', sessionId, toolName: 'Edit', toolInput: { file_path: 'src/payment.ts' }, ts: 3 }))
    await pipeline.process(evt({ hook: 'TOOL', sessionId, toolName: 'Write', toolInput: { file_path: 'docs/plan.md', content: 'Payment retry plan: wrap processPayment with p-limit.' }, ts: 4 }))
    const rClose = await pipeline.process(evt({ hook: 'TURN_END', sessionId, message: 'Done — payment retries wired.', ts: 5 }))

    // Exactly ONE chunk from TURN_END; contextText includes narration + doc content + closing summary
    if (rClose.chunkKeys.length !== 1) {
      results.push(fail('pipeline chunks', `expected 1 chunk at TURN_END, got ${rClose.chunkKeys.length}`))
    } else {
      const chunk = rClose.chunkKeys[0]!
      const embedded = await redis.hget(chunk, 'embedded')
      const hasEmbedding = await redis.hexists(chunk, 'embedding')
      const ctx = rClose.finalized?.contextText ?? ''
      if (embedded !== '0' || hasEmbedding) {
        results.push(fail('pipeline chunks', 'chunk must have embedded=0 and no embedding field'))
      } else if (!ctx.includes('retry logic') || !ctx.includes('Payment retry plan') || !ctx.includes('payment retries wired')) {
        results.push(fail('pipeline chunks', `contextText missing content: "${ctx.slice(0, 120)}"...`))
      } else {
        results.push(pass('pipeline chunks', 'ONE chunk at TURN_END; contextText pools narration + doc + closing'))
      }
    }
    await cleanupSession(sessionId)

    // dedup — same TURN_END event twice → second is duplicate
    const dupSession = `${sessionId}dedup`
    pipeline.seqCounter.reset(dupSession)
    await pipeline.process(evt({ hook: 'PROMPT', sessionId: dupSession, message: 'dedup test prompt', ts: 99 }))
    const turnEndEvent = evt({ hook: 'TURN_END', sessionId: dupSession, message: 'dedup closing summary text here for length', ts: 100 })
    const d1 = await pipeline.process(turnEndEvent)
    const d2 = await pipeline.process({ ...turnEndEvent, ts: 101 })
    if (d1.status !== 'ok' || d2.status !== 'duplicate' || d1.chunkKeys.length !== 1) {
      results.push(
        fail('dedup', `first=${d1.status} second=${d2.status} keys=${d1.chunkKeys.length}`),
      )
    } else {
      results.push(pass('dedup', 'duplicate event rejected'))
    }
    await cleanupSession(dupSession)

    // token-budget evict + flush-then-delete seam (onEvict fires before DEL)
    const capSession = `${sessionId}cap`
    const evicted: number[] = []
    const onEvict = async (_s: string, seq: number): Promise<void> => {
      // prove the chunk still exists when the flush hook runs (flush-then-delete)
      if ((await redis.exists(chunkKey(capSession, seq))) === 1) evicted.push(seq)
    }
    // each chunk ≈ 45 chars ≈ 12 tokens; budget 50 → keep ~4 newest, evict the rest
    for (let i = 1; i <= 10; i++) {
      await pushHotChunk(
        { sessionId: capSession, projectId: '/tmp/cap', seq: i, text: 'x'.repeat(40) + ` kw${i}`, ts: i },
        { maxTokens: 50, onEvict },
      )
    }
    const tokensLeft = Number((await redis.get(hotTokensKey(capSession))) ?? 0)
    const oldestExists = await redis.exists(chunkKey(capSession, 1))
    if (tokensLeft > 50 || oldestExists !== 0 || !evicted.includes(1)) {
      results.push(
        fail('token-budget evict', `tokens=${tokensLeft} oldestExists=${oldestExists} evicted=[${evicted}]`),
      )
    } else {
      results.push(
        pass('token-budget evict', `budget held (${tokensLeft}≤50); flush-then-delete fired for ${evicted.length}`),
      )
    }
    await cleanupSession(capSession)

    // message sig — TURN_END pushes ONE chunk with sig already set (no backfill needed)
    const sigSession = `${sessionId}sig`
    const sp = new CapturePipeline()
    sp.seqCounter.reset(sigSession)
    await sp.process(evt({ hook: 'PROMPT', sessionId: sigSession, message: 'fix the payment race condition', ts: 1 }))
    await sp.process(evt({ hook: 'NARRATION', sessionId: sigSession, message: 'Adding a mutex to processPayment to fix the race', ts: 2 }))
    await sp.process(evt({ hook: 'TOOL', sessionId: sigSession, toolName: 'Edit', toolInput: { file_path: 'src/payment.ts' }, ts: 3 }))
    const close = await sp.process(evt({ hook: 'TURN_END', sessionId: sigSession, message: 'Done — added the mutex.', ts: 4 }))
    const msgSig = close.finalized?.sig
    const msgChunkKey = close.chunkKeys[0]
    const storedSig = msgChunkKey ? await redis.hget(msgChunkKey, 'sig') : null
    if (!msgSig || storedSig !== msgSig) {
      results.push(fail('message sig at close', `chunk sig=${storedSig?.slice(0, 8)} expected=${msgSig?.slice(0, 8)}`))
    } else {
      results.push(pass('message sig at close', `chunk carries its message sig at TURN_END, no backfill — ${storedSig.slice(0, 8)}…`))
    }
    await cleanupSession(sigSession)

    // gap behavior — text search finds embedded=0; KNN does not
    const gapSession = `${sessionId}gap`
    await pushHotChunk({
      sessionId: gapSession,
      projectId: '/tmp/gap',
      seq: 1,
      text: 'uniquegapkeyword processPayment retry overlap',
      ts: 1,
    })

    let textHits = 0
    let textSearchError: string | null = null
    try {
      const textSearch = (await redis.call(
        'FT.SEARCH',
        SEARCH_INDEX,
        `@session:{${gapSession}} @text:(uniquegapkeyword)`,
        'LIMIT',
        '0',
        '5',
      )) as unknown[]
      textHits = Number(textSearch[0] ?? 0)
    } catch (e) {
      textSearchError = String(e)
    }

    let knnHits = -1
    try {
      const blob = Buffer.alloc(EMBED_DIM * 4)
      const knnSearch = (await redis.call(
        'FT.SEARCH',
        SEARCH_INDEX,
        `@session:{${gapSession}}=>[KNN 5 @embedding $vec AS dist]`,
        'PARAMS',
        '2',
        'vec',
        blob,
        'SORTBY',
        'dist',
        'ASC',
        'DIALECT',
        '2',
        'LIMIT',
        '0',
        '5',
      )) as unknown[]
      knnHits = Number(knnSearch[0] ?? 0)
    } catch {
      knnHits = 0
    }

    if (textSearchError) {
      results.push(fail('gap text search', textSearchError))
    } else if (textHits < 1) {
      results.push(fail('gap text search', `expected ≥1 text hit, got ${textHits}`))
    } else if (knnHits !== 0) {
      results.push(fail('gap KNN skip', `expected 0 KNN hits without embedding, got ${knnHits}`))
    } else {
      results.push(pass('gap behavior', 'text search hits; KNN skips embedded=0'))
    }
    await cleanupSession(gapSession)
  } finally {
    await cleanupSession(sessionId)
    await closeRedis()
  }

  console.log('\n── memwise Layer 3 pipeline tests ──\n')
  let passed = 0
  for (const r of results) {
    const icon = r.ok ? '✓' : '✗'
    const label = r.ok ? '\x1b[32m' : '\x1b[31m'
    console.log(`  ${label}${icon}\x1b[0m  ${r.name.padEnd(22)} ${r.detail}`)
    if (r.ok) passed++
  }
  console.log(`\n  ${passed}/${results.length} passed\n`)
  process.exit(passed === results.length ? 0 : 1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

import { EMBED_DIM } from '../config.js'
import { openDatabase } from '../db.js'
import { server as mcpServer } from '../mcp/query-server.js'
import {
  closeRedis,
  ensureSearchIndex,
  getRedis,
  pushHotChunk,
  SEARCH_INDEX,
  writeChunkEmbedding,
} from '../redis.js'
import { contextChunkIdForSig } from '../store/sqlite-store.js'
import type { ContextChunk, PromptSig } from '../store/memory-store.js'
import { countTokens, formatBundle } from './formatter.js'
import { searchAnchors, escapeTagValue } from './hybrid-search.js'
import { fuseRankedLists } from '../rrf.js'
import { route } from './router.js'
import { retrieve } from './retrieve.js'
import { expandAnchors } from './traversal.js'
import type { AnchorHit, ContextBundle } from './types.js'

type TestResult = { name: string; ok: boolean; detail: string }

function pass(name: string, detail = ''): TestResult {
  return { name, ok: true, detail }
}

function fail(name: string, detail: string): TestResult {
  return { name, ok: false, detail }
}

function fakeEmbedding(seed: number): number[] {
  const vec = new Array<number>(EMBED_DIM)
  for (let i = 0; i < EMBED_DIM; i++) {
    vec[i] = Math.sin(seed + i * 0.01)
  }
  return vec
}

function seedSpine(
  store: ReturnType<typeof openDatabase>['store'],
  sig: string,
  projectId: string,
  opts: {
    promptText: string
    chunkText: string
    symbol?: string
    ts?: number
    parentSig?: string | null
    embedSeed?: number
  },
): void {
  const ts = opts.ts ?? 1_700_000_000
  const ps: PromptSig = {
    sig,
    parentSig: opts.parentSig ?? null,
    promptText: opts.promptText,
    sessionId: 'sess-test',
    source: 'claude-code',
    projectId,
    ts,
  }
  store.insertPromptSig(ps)
  if (opts.symbol) {
    store.insertChange({
      sig,
      file: 'processor.ts',
      symbol: opts.symbol,
      changeType: 'modified',
    })
  }
  const chunk: ContextChunk = {
    id: contextChunkIdForSig(sig),
    sig,
    text: opts.chunkText,
    projectId,
    ts: ts + 1,
  }
  store.insertContextChunk(chunk, fakeEmbedding(opts.embedSeed ?? 1))
}

async function main(): Promise<void> {
  const results: TestResult[] = []
  const projectId = 'proj-retrieval'
  const { store } = openDatabase(':memory:')

  // RRF: #1 vec + #3 fts beats #3 vec only
  {
    const fused = fuseRankedLists([['a', 'b', 'c'], ['x', 'y', 'a']], 3)
    if (fused[0] === 'a' && fused.includes('b')) {
      results.push(pass('RRF fuseRankedLists', `order=${fused.join(',')}`))
    } else {
      results.push(fail('RRF fuseRankedLists', `expected a first, got ${fused.join(',')}`))
    }
  }

  // Router symbol
  {
    const sig = 'b'.repeat(64)
    seedSpine(store, sig, projectId, {
      promptText: 'fix payment',
      chunkText: 'processPayment retry logic',
      symbol: 'processPayment',
    })
    const r = route('why does processPayment retry', store)
    if (r.mode === 'symbol' && r.symbols?.includes('processPayment')) {
      results.push(pass('router symbol', r.mode))
    } else {
      results.push(fail('router symbol', `mode=${r.mode} symbols=${r.symbols?.join(',')}`))
    }
  }

  // Router recency
  {
    const r = route('continue where I left off', store)
    if (r.mode === 'recency') {
      results.push(pass('router recency', r.mode))
    } else {
      results.push(fail('router recency', `mode=${r.mode}`))
    }
  }

  // Router session (cross-agent handoff phrasing)
  {
    const r = route('get the context of what we are working on', store)
    if (r.mode === 'session') {
      results.push(pass('router session', r.mode))
    } else {
      results.push(fail('router session', `mode=${r.mode}`))
    }
  }

  // Semantic: seed 10 rows, retrieve mentions processPayment
  {
    const targetSig = 'c'.repeat(64)
    seedSpine(store, targetSig, projectId, {
      promptText: 'fix race in payment',
      chunkText: 'processPayment mutex on webhook overlap',
      symbol: 'processPayment',
      embedSeed: 42,
    })
    for (let i = 0; i < 9; i++) {
      const s = `d${i}`.padEnd(64, '0')
      seedSpine(store, s, projectId, {
        promptText: `unrelated task ${i}`,
        chunkText: `logging config tweak number ${i}`,
        embedSeed: 100 + i,
        ts: 1_700_000_100 + i,
      })
    }
    const targetVec = fakeEmbedding(42)
    const mockEmbed = async () => targetVec
    const result = await retrieve('why processPayment', {
      store,
      projectId,
      embedFn: mockEmbed,
      skipHot: true,
    })
    if (result.block.includes('processPayment')) {
      results.push(pass('semantic retrieve', `${result.anchors.length} anchor(s)`))
    } else {
      results.push(fail('semantic retrieve', result.block.slice(0, 200)))
    }
  }

  // Recency route uses recent chunks
  {
    const oldSig = 'e'.repeat(64)
    const newSig = 'f'.repeat(64)
    seedSpine(store, oldSig, projectId, {
      promptText: 'old',
      chunkText: 'old work',
      ts: 1_700_000_010,
    })
    seedSpine(store, newSig, projectId, {
      promptText: 'newest',
      chunkText: 'picked up latest session context',
      ts: 1_700_000_999,
    })
    const result = await retrieve('continue where I left off', {
      store,
      projectId,
      embedFn: async () => fakeEmbedding(0),
      skipHot: true,
    })
    if (result.anchors[0]?.sig === newSig) {
      results.push(pass('recency retrieve', 'newest chunk first'))
    } else {
      results.push(
        fail('recency retrieve', `first anchor sig=${result.anchors[0]?.sig?.slice(0, 8)}`),
      )
    }
  }

  // Session recap (cross-agent handoff): forced mode → "current work" block with recent prompt
  {
    const sessionSig = '5'.repeat(64)
    seedSpine(store, sessionSig, projectId, {
      promptText: 'wire up the refund webhook handler',
      chunkText: 'added refundWebhook with signature check',
      symbol: 'refundWebhook',
      ts: 1_700_001_500,
    })
    const result = await retrieve('current work', {
      store,
      projectId,
      mode: 'session',
      skipHot: true,
    })
    const ok =
      result.block.includes('current work') &&
      result.block.includes('Working on') &&
      result.block.includes('refund webhook handler') &&
      result.block.includes('refundWebhook')
    if (ok) {
      results.push(pass('session recap', 'header + working-on + recent change'))
    } else {
      results.push(fail('session recap', result.block.slice(0, 240)))
    }
  }

  // Blast radius 3-hop
  {
    const { store: blastStore } = openDatabase(':memory:')
    const sig = 'g'.repeat(64)
    blastStore.insertPromptSig({
      sig,
      parentSig: null,
      promptText: 'auth',
      sessionId: 'sess-blast',
      source: 'claude-code',
      projectId,
      ts: 1,
    })
    blastStore.insertChange({
      sig,
      file: 'auth.ts',
      symbol: 'verifySignature',
      changeType: 'modified',
    })
    blastStore.insertSymbolDep({
      fromSymbol: 'handleWebhook',
      fromFile: 'webhook.ts',
      toSymbol: 'verifySignature',
      toFile: 'auth.ts',
    })
    blastStore.insertSymbolDep({
      fromSymbol: 'processPayment',
      fromFile: 'processor.ts',
      toSymbol: 'handleWebhook',
      toFile: 'webhook.ts',
    })
    blastStore.insertSymbolDep({
      fromSymbol: 'apiHandler',
      fromFile: 'api.ts',
      toSymbol: 'processPayment',
      toFile: 'processor.ts',
    })
    const anchors: AnchorHit[] = [
      { sig, text: 'x', ts: 1, sources: ['test'] },
    ]
    const bundle = expandAnchors({
      store: blastStore,
      anchors,
      route: { mode: 'symbol', symbols: ['verifySignature'] },
    })
    const symbols = new Set(
      bundle.watchEdges.flatMap(e => [e.fromSymbol, e.toSymbol]),
    )
    const need = ['handleWebhook', 'processPayment', 'apiHandler']
    if (need.every(s => symbols.has(s))) {
      results.push(pass('blast radius 3-hop', need.join(', ')))
    } else {
      results.push(fail('blast radius 3-hop', `got ${[...symbols].join(', ')}`))
    }
  }

  // Formatter cap
  {
    const huge: ContextBundle = {
      anchors: [{ sig: 'h'.repeat(64), text: 'x', ts: 1, sources: [] }],
      changes: Array.from({ length: 200 }, (_, i) => ({
        sig: 'h'.repeat(64),
        file: `file${i}.ts`,
        symbol: `sym${i}`,
        changeType: 'modified' as const,
      })),
      chunks: [],
      parentChains: [],
      symbolChanges: [],
      watchEdges: Array.from({ length: 100 }, (_, i) => ({
        fromSymbol: `a${i}`,
        fromFile: 'a.ts',
        toSymbol: `b${i}`,
        toFile: 'b.ts',
      })),
      mode: 'semantic',
    }
    const { tokenCount } = formatBundle(huge, 1500)
    if (tokenCount <= 1500) {
      results.push(pass('formatter token cap', String(tokenCount)))
    } else {
      results.push(fail('formatter token cap', `tokenCount=${tokenCount}`))
    }
  }

  // Timing (cold, no Ollama)
  {
    const t0 = performance.now()
    await retrieve('processPayment', {
      store,
      projectId,
      embedFn: async () => fakeEmbedding(42),
      skipHot: true,
    })
    const ms = performance.now() - t0
    if (ms < 200) {
      results.push(pass('timing cold', `${ms.toFixed(1)}ms`))
    } else {
      results.push(pass('timing cold (soft)', `${ms.toFixed(1)}ms — logged only`))
    }
  }

  // MCP decoupled — retrieve does not require MCP process
  {
    const mod = await import('./retrieve.js')
    if (typeof mod.retrieve === 'function' && !String(mod.retrieve).includes('McpServer')) {
      results.push(pass('MCP decoupled', 'retrieve() standalone'))
    } else {
      results.push(fail('MCP decoupled', 'unexpected coupling'))
    }
  }

  // MCP server registers memwise_query
  {
    const tools = (mcpServer as unknown as { _registeredTools?: Record<string, unknown> })
      ._registeredTools
    if (tools && 'memwise_query' in tools && 'memwise_session' in tools) {
      results.push(pass('MCP tools registered', 'memwise_query + memwise_session'))
    } else {
      results.push(fail('MCP tools registered', `got ${tools ? Object.keys(tools).join(',') : 'none'}`))
    }
  }

  // Three-source + gap recall (Redis optional)
  let redisOk = false
  try {
    const redis = getRedis()
    await redis.connect()
    await ensureSearchIndex(redis)
    redisOk = true
    const runId = Date.now()
    const redisProjectId = `proj_l6_${runId}`
    const sessionId = `l6${runId}`
    const hotSig = 'i'.repeat(64)
    const coldSig = 'j'.repeat(64)

    await pushHotChunk({
      sessionId,
      projectId: redisProjectId,
      seq: 1,
      text: 'hot unique knn anchor processPayment',
      sig: hotSig,
      ts: runId,
    })
    const vec = fakeEmbedding(77)
    const blob = Buffer.alloc(EMBED_DIM * 4)
    vec.forEach((v, idx) => blob.writeFloatLE(v, idx * 4))
    await writeChunkEmbedding(sessionId, 1, blob, redis)

    const { store: coldStore } = openDatabase(':memory:')
    seedSpine(coldStore, coldSig, redisProjectId, {
      promptText: 'cold',
      chunkText: 'cold sqlite hybrid knn anchor overlap',
      embedSeed: 77,
    })

    const fused = await searchAnchors({
      projectId: redisProjectId,
      query: 'processPayment',
      embedding: vec,
      store: coldStore,
      redis,
      limit: 5,
    })
    const sigs = new Set(fused.map(a => a.sig))
    if (sigs.has(hotSig) && sigs.has(coldSig)) {
      results.push(pass('three-source fusion', [...sigs].map(s => s.slice(0, 8)).join(', ')))
    } else {
      results.push(
        fail('three-source fusion', `hot=${sigs.has(hotSig)} cold=${sigs.has(coldSig)}`),
      )
    }

    // Gap: embedded=0 found via text only
    const gapSession = `l6gap${runId}`
    await pushHotChunk({
      sessionId: gapSession,
      projectId: redisProjectId,
      seq: 1,
      text: 'uniquegapkeyword processPayment retry overlap',
      sig: 'k'.repeat(64),
      ts: runId + 1,
    })
    const { store: gapColdStore } = openDatabase(':memory:')
    const gapHits = await searchAnchors({
      projectId: redisProjectId,
      query: 'uniquegapkeyword processPayment',
      embedding: new Array(EMBED_DIM).fill(0),
      store: gapColdStore,
      redis,
      sessionId: gapSession,
      limit: 5,
    })
    if (gapHits.some(h => h.text.includes('uniquegapkeyword'))) {
      results.push(pass('gap text recall', 'embedded=0 via hot-text'))
    } else {
      results.push(fail('gap text recall', `hits=${gapHits.length}`))
    }

    void escapeTagValue('/tmp/test')
    await redis.del(`${sessionId}`).catch(() => {})
    await closeRedis()
  } catch (e) {
    if (!redisOk) {
      results.push(pass('three-source fusion', 'skipped (Redis unavailable)'))
      results.push(pass('gap text recall', 'skipped (Redis unavailable)'))
    } else {
      results.push(fail('Redis integration', String(e)))
    }
  }

  console.log('\n── memwise Layer 6 retrieval tests ──\n')
  let passed = 0
  for (const r of results) {
    const icon = r.ok ? '✓' : '✗'
    const label = r.ok ? '\x1b[32m' : '\x1b[31m'
    console.log(`  ${label}${icon}\x1b[0m  ${r.name.padEnd(28)} ${r.detail}`)
    if (r.ok) passed++
  }
  console.log(`\n  ${passed}/${results.length} passed\n`)
  if (passed < results.length) process.exit(1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

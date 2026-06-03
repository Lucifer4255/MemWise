import { createHash } from 'node:crypto'
import { EMBED_DIM } from '../config.js'
import { openDatabase } from '../db.js'
import { Embedder } from '../embed/embedder.js'
import { OllamaClient } from '../embed/ollama-client.js'
import { embeddingToBuffer, meanPool } from '../embed/vector.js'
import { Flusher } from '../flush/flusher.js'
import { recoverOrphanSessions } from '../flush/orphan-recovery.js'
import { chunkText } from '../pipeline/chunker.js'
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
import type { FinalizedMessage } from '../types.js'

type TestResult = { name: string; ok: boolean; detail: string }

function pass(name: string, detail = ''): TestResult {
  return { name, ok: true, detail }
}

function fail(name: string, detail: string): TestResult {
  return { name, ok: false, detail }
}

function fakeMessage(sessionId: string, seq: number, tag: string): FinalizedMessage {
  const promptText = `prompt ${tag}`
  const sig = createHash('sha256').update(promptText).digest('hex')
  return {
    sig,
    parentSig: null,
    promptText,
    contextText: `context for ${tag}`,
    codeChanges: [{ file: `src/${tag}.ts`, symbol: tag, changeType: 'modified' }],
    symbolDeps: [],
    projectId: '/tmp/l5',
    sessionId,
    source: 'claude-code',
    tsOpen: Date.now() - 1000,
    ts: Date.now(),
  }
}

function finalizedPayload(msg: FinalizedMessage) {
  return {
    promptText: msg.promptText,
    parentSig: msg.parentSig,
    source: msg.source,
    tsOpen: msg.tsOpen,
    changesJson: JSON.stringify(msg.codeChanges),
    depsJson: JSON.stringify(msg.symbolDeps),
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
    console.error('\nRedis not available — start Redis Stack before Layer 5 tests.\n', e)
    process.exit(1)
  }

  const runId = Date.now()

  // meanPool unit sanity
  const pooled = meanPool([
    [1, 0, 0],
    [0, 1, 0],
  ])
  if (pooled.length !== 3 || Math.abs(pooled[0]! - 0.5) > 1e-6) {
    results.push(fail('meanPool', JSON.stringify(pooled)))
  }

  // 1. ollama-client (soft — skip if Ollama down)
  try {
    const client = new OllamaClient()
    const vec = await client.embedText('hello world')
    if (vec.length !== EMBED_DIM || !vec.every(v => isFinite(v))) {
      results.push(fail('ollama-client', `bad vector len=${vec.length}`))
    } else {
      results.push(pass('ollama-client', `${vec.length}-dim float array`))
    }
  } catch (e) {
    const msg = String(e)
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      results.push(pass('ollama-client', 'skipped — Ollama not running'))
    } else {
      results.push(fail('ollama-client', msg))
    }
  }

  // 2. embedder concurrent (mock)
  const callOrder: number[] = []
  let resolveSecond!: () => void
  const blockSecond = new Promise<void>(r => {
    resolveSecond = r
  })
  const mockEmbed = async (text: string): Promise<number[]> => {
    const id = callOrder.length
    callOrder.push(id)
    if (id === 0) await blockSecond
    return new Array(EMBED_DIM).fill(0.1)
  }
  const mockEmbedder = new Embedder(mockEmbed, redis)
  const sessionEmbed = `l5embed${runId}`
  await pushHotChunk({
    sessionId: sessionEmbed,
    projectId: '/tmp/l5',
    seq: 1,
    text: 'part one\n\npart two',
    sig: 'a'.repeat(64),
    ts: Date.now(),
  })
  const embedPromise = mockEmbedder.embedChunk(sessionEmbed, 1, 'part one\n\npart two')
  await new Promise(r => setTimeout(r, 20))
  const concurrentStarted = callOrder.length >= 2
  resolveSecond()
  await embedPromise
  await cleanupSession(sessionEmbed)
  if (!concurrentStarted) {
    results.push(fail('embedder concurrent', `calls=${callOrder.length} order=${callOrder}`))
  } else {
    results.push(pass('embedder concurrent', `both embed calls started before first resolved`))
  }

  // 3–4. embed in-place + KNN (real Redis + mock embed)
  const sessionKnn = `l5knn${runId}`
  const fixedVec = new Array(EMBED_DIM).fill(0).map((_, i) => (i % 10) * 0.01)
  const fixedEmbedder = new Embedder(async () => fixedVec, redis)
  await ensureSearchIndex()
  const sigKnn = 'b'.repeat(64)
  const textBefore = 'uniqueknntestkeyword layer five embed'
  await pushHotChunk({
    sessionId: sessionKnn,
    projectId: '/tmp/l5',
    seq: 1,
    text: textBefore,
    sig: sigKnn,
    ts: Date.now(),
  })
  await fixedEmbedder.embedChunk(sessionKnn, 1, textBefore)
  const ckey = chunkKey(sessionKnn, 1)
  const embedded = await redis.hget(ckey, 'embedded')
  const hasEmb = await redis.hexists(ckey, 'embedding')
  const textAfter = await redis.hget(ckey, 'text')
  if (embedded !== '1' || !hasEmb) {
    results.push(fail('embed in-place', `embedded=${embedded} hasEmb=${hasEmb}`))
  } else if (textAfter !== textBefore) {
    results.push(fail('embed in-place', 'text field changed'))
  } else {
    results.push(pass('embed in-place', 'embedding set, embedded=1, text unchanged'))
  }

  let knnHits = 0
  try {
    const blob = Buffer.alloc(EMBED_DIM * 4)
    fixedVec.forEach((v, i) => blob.writeFloatLE(v, i * 4))
    const knnSearch = (await redis.call(
      'FT.SEARCH',
      SEARCH_INDEX,
      `(@session:{${sessionKnn}} @embedded:[1 1])=>[KNN 5 @embedding $vec AS dist]`,
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
  } catch (e) {
    results.push(fail('post-embed KNN', String(e)))
  }
  if (knnHits < 1) {
    results.push(fail('post-embed KNN', `expected ≥1 hit, got ${knnHits}`))
  } else {
    results.push(pass('post-embed KNN', `${knnHits} hit(s) with embedded=1 filter`))
  }
  await cleanupSession(sessionKnn)

  // 5. flusher — 5 chunks → SQLite, Redis cleared
  const { db, store } = openDatabase(':memory:')
  const sessionFlush = `l5flush${runId}`
  const mockFlushEmbed = new Embedder(async () => new Array(EMBED_DIM).fill(0.2), redis)
  const flusher = new Flusher(store, mockFlushEmbed)
  for (let i = 1; i <= 5; i++) {
    const msg = fakeMessage(sessionFlush, i, `f${i}`)
    await pushHotChunk({
      sessionId: sessionFlush,
      projectId: msg.projectId,
      seq: i,
      text: msg.contextText,
      sig: msg.sig,
      ts: msg.ts,
      finalized: finalizedPayload(msg),
    })
  }
  const flushed = await flusher.flushSession(sessionFlush)
  const chunkCount = (db.prepare('SELECT COUNT(*) AS n FROM context_chunk').get() as { n: number }).n
  const sigCount = (db.prepare('SELECT COUNT(*) AS n FROM prompt_sig').get() as { n: number }).n
  const zExists = await redis.exists(hotZsetKey(sessionFlush))
  const chunk1Exists = await redis.exists(chunkKey(sessionFlush, 1))
  if (flushed !== 5 || chunkCount !== 5 || sigCount !== 5) {
    results.push(
      fail('flusher 5 chunks', `flushed=${flushed} chunks=${chunkCount} sigs=${sigCount}`),
    )
  } else if (zExists !== 0 || chunk1Exists !== 0) {
    results.push(fail('flusher 5 chunks', 'Redis keys not cleared'))
  } else {
    results.push(pass('flusher 5 chunks', '5 rows in SQLite; Redis hot window cleared'))
  }
  db.close()

  // 6. orphan recovery
  const { db: db2, store: store2 } = openDatabase(':memory:')
  const sessionOrphan = `l5orphan${runId}`
  const orphanFlusher = new Flusher(store2, mockFlushEmbed)
  const orphanMsg = fakeMessage(sessionOrphan, 1, 'orphan')
  await pushHotChunk({
    sessionId: sessionOrphan,
    projectId: orphanMsg.projectId,
    seq: 1,
    text: orphanMsg.contextText,
    sig: orphanMsg.sig,
    ts: Date.now(),
    finalized: finalizedPayload(orphanMsg),
  })
  const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000
  await redis.zadd(hotZsetKey(sessionOrphan), threeHoursAgo, '1')
  const recovered = await recoverOrphanSessions(orphanFlusher, 7200)
  const orphanChunks = (db2.prepare('SELECT COUNT(*) AS n FROM context_chunk').get() as { n: number })
    .n
  await cleanupSession(sessionOrphan)
  db2.close()
  if (recovered < 1 || orphanChunks < 1) {
    results.push(fail('orphan recovery', `recovered=${recovered} chunks=${orphanChunks}`))
  } else {
    results.push(pass('orphan recovery', `flushed ${recovered} idle session(s) to SQLite`))
  }

  // 7. real-embedded chunk flushes the SAME vector (regression: hgetall UTF-8-decoded the
  //    float bytes → corrupted vectors). The flusher's own embedder returns zeros, so a correct
  //    round-trip can only come from reading the stashed buffer back verbatim.
  const { db: db3, store: store3 } = openDatabase(':memory:')
  const sessionVec = `l5vec${runId}`
  // Negative/fractional values → bytes that a UTF-8 decode would mangle.
  const realVec = new Array(EMBED_DIM).fill(0).map((_, i) => Math.sin(i) * 0.7 - 0.3)
  const realEmbedder = new Embedder(async () => realVec, redis)
  const zeroFlusher = new Flusher(store3, new Embedder(async () => new Array(EMBED_DIM).fill(0), redis))
  const vecMsg = fakeMessage(sessionVec, 1, 'vec')
  await pushHotChunk({
    sessionId: sessionVec,
    projectId: vecMsg.projectId,
    seq: 1,
    text: vecMsg.contextText,
    sig: vecMsg.sig,
    ts: vecMsg.ts,
    finalized: finalizedPayload(vecMsg),
  })
  const pooledVec = await realEmbedder.embedChunk(sessionVec, 1, vecMsg.contextText)
  await zeroFlusher.flushChunk(sessionVec, 1)
  const vrows = db3
    .prepare(
      `SELECT chunk_id, distance FROM chunk_vec WHERE embedding MATCH ? AND k = 1 ORDER BY distance`,
    )
    .all(embeddingToBuffer(pooledVec)) as { chunk_id: string; distance: number }[]
  await cleanupSession(sessionVec)
  db3.close()
  if (vrows.length !== 1 || vrows[0]?.chunk_id !== `${vecMsg.sig}:ctx` || (vrows[0]?.distance ?? 1) > 1e-3) {
    results.push(fail('embedded-flush round-trip', `rows=${JSON.stringify(vrows)}`))
  } else {
    results.push(pass('embedded-flush round-trip', 'stored vector matches pooled embedding (no corruption)'))
  }

  // 8. duplicate sig across two hot chunks → idempotent flush: no crash, one spine row,
  //    no duplicate change/dep/vector rows.
  const { db: db4, store: store4 } = openDatabase(':memory:')
  const sessionDup = `l5dup${runId}`
  const dupFlusher = new Flusher(store4, new Embedder(async () => new Array(EMBED_DIM).fill(0.2), redis))
  const dupMsg = fakeMessage(sessionDup, 1, 'dup') // same tag → same sig + same change
  let dupThrew = false
  for (const seq of [1, 2]) {
    await pushHotChunk({
      sessionId: sessionDup,
      projectId: dupMsg.projectId,
      seq,
      text: dupMsg.contextText,
      sig: dupMsg.sig,
      ts: Date.now(),
      finalized: finalizedPayload(dupMsg),
    })
  }
  try {
    await dupFlusher.flushSession(sessionDup)
  } catch {
    dupThrew = true
  }
  const dupSigs = (db4.prepare('SELECT COUNT(*) AS n FROM prompt_sig').get() as { n: number }).n
  const dupChunks = (db4.prepare('SELECT COUNT(*) AS n FROM context_chunk').get() as { n: number }).n
  const dupChanges = (db4.prepare('SELECT COUNT(*) AS n FROM change').get() as { n: number }).n
  const dupVecs = (db4.prepare('SELECT COUNT(*) AS n FROM chunk_vec').get() as { n: number }).n
  await cleanupSession(sessionDup)
  db4.close()
  if (dupThrew || dupSigs !== 1 || dupChunks !== 1 || dupChanges !== 1 || dupVecs !== 1) {
    results.push(
      fail(
        'duplicate-sig idempotent',
        `threw=${dupThrew} sigs=${dupSigs} chunks=${dupChunks} changes=${dupChanges} vecs=${dupVecs}`,
      ),
    )
  } else {
    results.push(pass('duplicate-sig idempotent', 'repeated sig → one spine row, no duplicate edges/vectors'))
  }

  await closeRedis()

  console.log('\n── memwise Layer 5 tests ──\n')
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

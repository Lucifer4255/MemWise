import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import Parser from 'tree-sitter'
import TSTypeScript from 'tree-sitter-typescript'
import { EMBED_MODEL, EMBED_DIM, OLLAMA_URL } from '../src/core/config.js'

type Result = { name: string; ok: boolean; detail: string }

function pass(name: string, detail = ''): Result {
  return { name, ok: true, detail }
}

function fail(name: string, detail: string): Result {
  return { name, ok: false, detail }
}

// ── 1. better-sqlite3 ────────────────────────────────────────────────────────
function testSqlite(): Result {
  try {
    const db = new Database(':memory:')
    const row = db.prepare('SELECT 1 AS val').get() as { val: number }
    db.close()
    if (row.val !== 1) return fail('better-sqlite3', `SELECT 1 returned ${row.val}`)
    return pass('better-sqlite3', 'SELECT 1 → 1')
  } catch (e) {
    return fail('better-sqlite3', String(e))
  }
}

// ── 2. sqlite-vec ────────────────────────────────────────────────────────────
function testSqliteVec(): Result {
  try {
    const db = new Database(':memory:')
    sqliteVec.load(db)

    db.exec(`CREATE VIRTUAL TABLE vtest USING vec0(embedding FLOAT[4])`)
    const vec = new Float32Array([0.1, 0.2, 0.3, 0.4])
    const vecBuf = Buffer.from(vec.buffer)
    db.prepare(`INSERT INTO vtest(embedding) VALUES (?)`).run(vecBuf)

    const rows = db.prepare(
      `SELECT rowid FROM vtest WHERE embedding MATCH ? AND k = 1 ORDER BY distance`
    ).all(vecBuf) as { rowid: number | bigint }[]

    db.close()
    if (rows.length !== 1)
      return fail('sqlite-vec', `KNN returned ${rows.length} rows, expected 1`)
    return pass('sqlite-vec', 'vec0 insert + KNN query → rowid 1')
  } catch (e) {
    return fail('sqlite-vec', String(e))
  }
}

// ── 3. tree-sitter ───────────────────────────────────────────────────────────
function testTreeSitter(): Result {
  try {
    const parser = new Parser()
    // TSTypeScript exports { typescript, tsx }
    const lang = (TSTypeScript as unknown as { typescript: Parser.Language }).typescript
    parser.setLanguage(lang)
    const tree = parser.parse('const x = 1')
    const root = tree.rootNode
    if (root.type !== 'program')
      return fail('tree-sitter', `root node type = "${root.type}", expected "program"`)
    const ids = root.descendantsOfType('identifier')
    if (!ids.some(n => n.text === 'x'))
      return fail('tree-sitter', 'identifier "x" not found in parse tree')
    return pass('tree-sitter', `root=program, found identifier "x"`)
  } catch (e) {
    return fail('tree-sitter', String(e))
  }
}

// ── 4. Ollama HTTP ───────────────────────────────────────────────────────────
async function testOllama(): Promise<Result> {
  const url = `${OLLAMA_URL}/api/embeddings`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: 'hello world' }),
      signal: AbortSignal.timeout(30000), // generous: first request cold-loads the model into RAM (§18)
    })
    if (!res.ok) return fail('ollama', `HTTP ${res.status}: ${await res.text()}`)
    const body = (await res.json()) as { embedding?: number[] }
    if (!Array.isArray(body.embedding))
      return fail('ollama', `no embedding array in response`)
    // EMBED_DIM is config-declared; flag a mismatch so swaps don't silently break the schema
    if (body.embedding.length !== EMBED_DIM)
      return fail('ollama', `${EMBED_MODEL} returned ${body.embedding.length} dims, but EMBED_DIM=${EMBED_DIM} — fix config`)
    const allFloats = body.embedding.every(v => typeof v === 'number' && isFinite(v))
    if (!allFloats) return fail('ollama', 'embedding contains non-finite values')
    return pass('ollama', `${EMBED_MODEL} → ${EMBED_DIM}-dim float array`)
  } catch (e: unknown) {
    const msg = String(e)
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      return fail('ollama', `NOT RUNNING — install ollama + \`ollama pull ${EMBED_MODEL}\`, then \`ollama serve\``)
    }
    return fail('ollama', msg)
  }
}

// ── runner ───────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n── memwise Layer 0 smoke tests ──\n')

  const results: Result[] = [
    testSqlite(),
    testSqliteVec(),
    testTreeSitter(),
    await testOllama(),
  ]

  let passed = 0
  let failed = 0
  for (const r of results) {
    const icon = r.ok ? '✓' : '✗'
    const label = r.ok ? '\x1b[32m' : '\x1b[31m'
    const reset = '\x1b[0m'
    console.log(`  ${label}${icon}${reset}  ${r.name.padEnd(18)} ${r.detail}`)
    r.ok ? passed++ : failed++
  }

  console.log(`\n  ${passed}/${results.length} passed\n`)

  // Exit 1 only if a hard dep fails (ollama is a warning for now if not installed)
  const hardFails = results.filter(r => !r.ok && r.name !== 'ollama')
  process.exit(hardFails.length > 0 ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })

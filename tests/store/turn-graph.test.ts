import { openDatabase } from '../db.js'
import { persistMessage } from '../capture/persist.js'
import type { ContextChunk } from './memory-store.js'

type R = { name: string; ok: boolean; detail: string }
const pass = (name: string, detail = ''): R => ({ name, ok: true, detail })
const fail = (name: string, detail: string): R => ({ name, ok: false, detail })

function noEmbedding(_text: string): Promise<number[]> {
  return Promise.resolve([])
}

async function main(): Promise<void> {
  const results: R[] = []
  const { store } = openDatabase(':memory:')

  const projectId = 'proj-graph'
  const sessionId = 'sess-graph'

  // Turn 1: touches auth.ts / verifyToken
  const sig1 = 'a'.repeat(64)
  await persistMessage(
    store,
    {
      sig: sig1,
      parentSig: null,
      promptText: 'add JWT verification',
      contextText: 'added verifyToken to auth.ts',
      codeChanges: [{ file: 'auth.ts', symbol: 'verifyToken', changeType: 'added' }],
      symbolDeps: [],
      projectId,
      sessionId,
      source: 'claude-code',
      tsOpen: 1000,
      ts: 1000,
    },
    'added verifyToken to auth.ts',
    [],
    false,
  )

  // Turn 2: touches auth.ts / refreshToken (same file, different symbol)
  const sig2 = 'b'.repeat(64)
  await persistMessage(
    store,
    {
      sig: sig2,
      parentSig: sig1,
      promptText: 'add token refresh',
      contextText: 'added refreshToken to auth.ts',
      codeChanges: [{ file: 'auth.ts', symbol: 'refreshToken', changeType: 'added' }],
      symbolDeps: [],
      projectId,
      sessionId,
      source: 'claude-code',
      tsOpen: 2000,
      ts: 2000,
    },
    'added refreshToken to auth.ts',
    [],
    false,
  )

  // Turn 3: touches payments.ts / charge AND auth.ts / verifyToken (two files, one revisited symbol)
  const sig3 = 'c'.repeat(64)
  await persistMessage(
    store,
    {
      sig: sig3,
      parentSig: sig2,
      promptText: 'wire auth into payments',
      contextText: 'updated charge in payments.ts to call verifyToken',
      codeChanges: [
        { file: 'payments.ts', symbol: 'charge', changeType: 'modified' },
        { file: 'auth.ts', symbol: 'verifyToken', changeType: 'modified' },
      ],
      symbolDeps: [],
      projectId,
      sessionId,
      source: 'claude-code',
      tsOpen: 3000,
      ts: 3000,
    },
    'updated charge in payments.ts to call verifyToken',
    [],
    false,
  )

  // ── test 1: forward edges ────────────────────────────────────────────────
  const sig1Edges = store.getEdgeNeighbors(sig1, 20)
  const sig1ForwardToSig2 = sig1Edges.some(
    e => e.edgeType === 'forward' && e.fromSig === sig1 && e.toSig === sig2,
  )
  results.push(
    sig1ForwardToSig2
      ? pass('forward edge sig1→sig2', 'parent→child spine edge written')
      : fail('forward edge sig1→sig2', `edges: ${JSON.stringify(sig1Edges)}`),
  )

  const sig2Edges = store.getEdgeNeighbors(sig2, 20)
  const sig2ForwardToSig3 = sig2Edges.some(
    e => e.edgeType === 'forward' && e.fromSig === sig2 && e.toSig === sig3,
  )
  results.push(
    sig2ForwardToSig3
      ? pass('forward edge sig2→sig3', 'parent→child spine edge written')
      : fail('forward edge sig2→sig3', `edges: ${JSON.stringify(sig2Edges)}`),
  )

  // ── test 2: file edges — sig2 and sig3 both touch auth.ts ──────────────
  const sig3Edges = store.getEdgeNeighbors(sig3, 20)
  const sig3AuthFileEdge = sig3Edges.some(
    e => e.edgeType === 'file' && e.label === 'auth.ts' && e.fromSig === sig3 && e.toSig === sig2,
  )
  results.push(
    sig3AuthFileEdge
      ? pass('file edge sig3→sig2 (auth.ts)', 'auth.ts chain: sig3→sig2')
      : fail('file edge sig3→sig2 (auth.ts)', `sig3 edges: ${JSON.stringify(sig3Edges)}`),
  )

  // ── test 3: symbol edges — sig1 and sig3 both touch verifyToken ─────────
  const sig3SymbolEdge = sig3Edges.some(
    e => e.edgeType === 'symbol' && e.label === 'verifyToken' && e.fromSig === sig3 && e.toSig === sig1,
  )
  results.push(
    sig3SymbolEdge
      ? pass('symbol edge sig3→sig1 (verifyToken)', 'verifyToken chain: sig3→sig1')
      : fail('symbol edge sig3→sig1 (verifyToken)', `sig3 edges: ${JSON.stringify(sig3Edges)}`),
  )

  // ── test 4: getPriorTurnForFile finds correct prior turn ─────────────────
  const priorForAuth = store.getPriorTurnForFile('auth.ts', projectId, sig3)
  results.push(
    priorForAuth === sig2
      ? pass('getPriorTurnForFile', `most recent prior = sig2`)
      : fail('getPriorTurnForFile', `got ${priorForAuth}, expected ${sig2}`),
  )

  // ── test 5: getEdgeNeighbors from sig2 reaches both sig1 and sig3 ────────
  const sig2Neighbors = store.getEdgeNeighbors(sig2, 20)
  const neighborSigs = new Set(
    sig2Neighbors.map(e => (e.fromSig === sig2 ? e.toSig : e.fromSig)),
  )
  results.push(
    neighborSigs.has(sig1) && neighborSigs.has(sig3)
      ? pass('getEdgeNeighbors bidirectional', `sig2 sees sig1 (${sig1.slice(0,4)}…) and sig3 (${sig3.slice(0,4)}…)`)
      : fail('getEdgeNeighbors bidirectional', `neighbor sigs: ${[...neighborSigs].map(s => s.slice(0,4)).join(', ')}`),
  )

  // ── test 6: no self-edges ────────────────────────────────────────────────
  const allEdges = [
    ...store.getEdgeNeighbors(sig1, 20),
    ...store.getEdgeNeighbors(sig2, 20),
    ...store.getEdgeNeighbors(sig3, 20),
  ]
  const selfEdges = allEdges.filter(e => e.fromSig === e.toSig)
  results.push(
    selfEdges.length === 0
      ? pass('no self-edges', 'all edges connect distinct turns')
      : fail('no self-edges', `${selfEdges.length} self-edge(s) found`),
  )

  // ── test 7: connected chunks surface in traversal ────────────────────────
  // Use sig1 as anchor — its parent chain is just [sig1] (no parents), so graph neighbors
  // sig2 (via forward edge) and sig3 (via symbol reverse edge) are genuinely new context.
  const { expandAnchors } = await import('../retrieval/traversal.js')
  const bundle = expandAnchors({
    store,
    anchors: [{ sig: sig1, text: 'added verifyToken to auth.ts', ts: 1000, sources: ['test'] }],
    mode: 'semantic',
  })
  const connectedSigs = new Set((bundle.connectedChunks ?? []).map((c: ContextChunk) => c.sig))
  results.push(
    connectedSigs.has(sig2) || connectedSigs.has(sig3)
      ? pass('connectedChunks non-empty', `found ${[...connectedSigs].map(s => s.slice(0,4)).join(', ')} via graph`)
      : fail('connectedChunks non-empty', `connectedSigs=${[...connectedSigs].map(s => s.slice(0,4)).join(', ')}, parentChain=${bundle.parentChains.map(c => c.map(p=>p.sig.slice(0,4)).join('→')).join(' | ')}`),
  )

  // ── print results ────────────────────────────────────────────────────────
  console.log('\n── turn graph (v6) tests ──\n')
  let ok = 0
  for (const r of results) {
    const icon = r.ok ? '✓' : '✗'
    const col = r.ok ? '\x1b[32m' : '\x1b[31m'
    console.log(`  ${col}${icon}\x1b[0m  ${r.name.padEnd(40)} ${r.detail}`)
    if (r.ok) ok++
  }
  console.log(`\n  ${ok}/${results.length} passed\n`)
  process.exit(ok === results.length ? 0 : 1)
}

main().catch(e => { console.error(e); process.exit(1) })

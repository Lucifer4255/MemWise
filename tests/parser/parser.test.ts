import {
  getTreeCache,
  parseIncremental,
  parseIncrementalOrFallback,
  parseInWorker,
  resetTreeCache,
  shutdownParserWorker,
} from '../../src/parser/index.js'

type TestResult = { name: string; ok: boolean; detail: string }

function pass(name: string, detail = ''): TestResult {
  return { name, ok: true, detail }
}

function fail(name: string, detail: string): TestResult {
  return { name, ok: false, detail }
}

const SESSION = 'parser-test-session'
const FILE = 'src/payment.ts'

const OLD_SRC = `function alpha() {
  return 1;
}

function beta() {
  return 2;
}
`

const NEW_SRC = `function alpha() {
  return 1;
}

function beta() {
  return 99;
}
`

function runSync(): TestResult[] {
  const results: TestResult[] = []
  resetTreeCache()

  const r1 = parseIncremental(
    { sessionId: SESSION, file: FILE, oldContent: OLD_SRC, newContent: NEW_SRC },
    getTreeCache(),
  )
  if (r1.changedRanges.length !== 1) {
    results.push(fail('changed range count', `expected 1, got ${r1.changedRanges.length}`))
  } else {
    results.push(pass('changed range count', 'getChangedRanges → 1 range'))
  }

  const names = r1.symbols.map(s => s.symbol)
  if (!names.includes('beta')) {
    results.push(fail('edited symbol', `expected beta in [${names.join(', ')}]`))
  } else {
    results.push(pass('edited symbol', 'beta present'))
  }

  if (names.includes('alpha')) {
    results.push(fail('unedited symbol absent', 'alpha should not appear'))
  } else {
    results.push(pass('unedited symbol absent', 'alpha not in changed symbols'))
  }

  resetTreeCache()
  const c = getTreeCache()
  parseIncremental({ sessionId: SESSION, file: FILE, oldContent: OLD_SRC, newContent: NEW_SRC }, c)
  const mid = `${NEW_SRC}
function gamma() {
  return 3;
}
`
  parseIncremental({ sessionId: SESSION, file: FILE, oldContent: NEW_SRC, newContent: mid }, c)
  if (c.fullParseCount !== 1 || c.incrementalParseCount !== 1) {
    results.push(
      fail('tree cache reuse', `full=${c.fullParseCount} incremental=${c.incrementalParseCount}`),
    )
  } else {
    results.push(pass('tree cache reuse', 'full=1, incremental=1'))
  }

  // Go — incremental symbol for edited function only
  resetTreeCache()
  const goOld = `package main

func Alpha() int { return 1 }

func Beta() int { return 2 }
`
  const goNew = goOld.replace('return 2', 'return 99')
  const goR = parseIncremental(
    { sessionId: SESSION, file: 'handler.go', oldContent: goOld, newContent: goNew },
    getTreeCache(),
  )
  const goNames = goR.symbols.map(s => s.symbol)
  if (!goNames.includes('Beta') || goNames.includes('Alpha')) {
    results.push(fail('go symbol', `expected Beta only, got [${goNames.join(', ')}]`))
  } else {
    results.push(pass('go symbol', 'Beta present, Alpha absent'))
  }

  // Rust
  resetTreeCache()
  const rsOld = `fn alpha() -> i32 { 1 }\nfn beta() -> i32 { 2 }\n`
  const rsNew = `fn alpha() -> i32 { 1 }\nfn beta() -> i32 { 99 }\n`
  const rsR = parseIncremental(
    { sessionId: SESSION, file: 'lib.rs', oldContent: rsOld, newContent: rsNew },
    getTreeCache(),
  )
  const rsNames = rsR.symbols.map(s => s.symbol)
  if (!rsNames.includes('beta') || rsNames.includes('alpha')) {
    results.push(fail('rust symbol', `expected beta only, got [${rsNames.join(', ')}]`))
  } else {
    results.push(pass('rust symbol', 'beta present, alpha absent'))
  }

  resetTreeCache()
  const bin = parseIncrementalOrFallback({
    sessionId: SESSION,
    file: FILE,
    oldContent: 'function ok() {}\n',
    newContent: 'function ok() {}\n\0BINARY',
  })
  if (!bin.fileLevelFallback || bin.symbols[0]?.symbol !== FILE) {
    results.push(fail('file-level fallback', JSON.stringify(bin)))
  } else {
    results.push(pass('file-level fallback', 'binary → file path symbol'))
  }

  // Dependency edges (gap #1): a changed function that calls another → call edge extracted.
  resetTreeCache()
  const depOld = `function helper() { return 1 }
function processPayment() {
  return 2
}
`
  const depNew = `function helper() { return 1 }
function processPayment() {
  return helper()
}
`
  const depR = parseIncremental(
    { sessionId: SESSION, file: 'pay.ts', oldContent: depOld, newContent: depNew },
    getTreeCache(),
  )
  const callEdge = depR.deps.find(d => d.fromSymbol === 'processPayment' && d.toSymbol === 'helper')
  if (!callEdge) {
    results.push(fail('dependency edge', `expected processPayment→helper, got ${JSON.stringify(depR.deps)}`))
  } else if (callEdge.toFile !== 'pay.ts') {
    results.push(fail('dependency edge', `local callee should set to_file=pay.ts, got ${callEdge.toFile}`))
  } else {
    results.push(pass('dependency edge', 'processPayment --calls--> helper (local, to_file set)'))
  }

  return results
}

async function runWorkerTest(): Promise<TestResult> {
  resetTreeCache()
  let ticks = 0
  const timer = setInterval(() => {
    ticks++
  }, 1)

  const result = await parseInWorker({
    sessionId: 'worker-session',
    file: FILE,
    oldContent: OLD_SRC,
    newContent: NEW_SRC,
  })
  clearInterval(timer)
  await shutdownParserWorker()

  if (ticks < 2) {
    return fail('worker non-blocking', `event loop ticks=${ticks}`)
  }
  if (!result.symbols.some(s => s.symbol === 'beta')) {
    return fail('worker parse result', JSON.stringify(result.symbols))
  }
  return pass('worker non-blocking', `ticks=${ticks} while worker parsed; beta resolved`)
}

function printResults(results: TestResult[]): void {
  let passed = 0
  console.log('\n── memwise Layer 4 parser tests ──\n')
  for (const r of results) {
    const icon = r.ok ? '✓' : '✗'
    const label = r.ok ? '\x1b[32m' : '\x1b[31m'
    const reset = '\x1b[0m'
    console.log(`  ${label}${icon}${reset}  ${r.name.padEnd(28)} ${r.detail}`)
    if (r.ok) passed++
  }
  console.log(`\n  ${passed}/${results.length} passed\n`)
  if (passed !== results.length) process.exit(1)
}

async function main(): Promise<void> {
  const results = runSync()
  results.push(await runWorkerTest())
  printResults(results)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})

import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseIncrementalOrFallback } from './incremental.js'
import type { CacheStats, ParseJob, ParseResult } from './types.js'
import type { WorkerRequest, WorkerResponse } from './types.js'

let nextId = 1
let child: ChildProcess | null = null
const pending = new Map<number, { resolve: (v: ParseResult) => void; reject: (e: Error) => void }>()

function workerScriptPath(): string {
  return fileURLToPath(new URL('./worker-ipc.ts', import.meta.url))
}

function forkExecArgv(): string[] {
  const base = process.execArgv.filter(a => !a.startsWith('--test'))
  if (base.some(a => a.includes('tsx'))) return base
  return [...base, '--import', 'tsx/esm/api']
}

function ensureChild(): ChildProcess {
  if (!child) {
    child = fork(workerScriptPath(), [], {
      execArgv: forkExecArgv(),
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    child.on('message', (msg: WorkerResponse) => {
      if ('result' in msg && msg.ok) {
        pending.get(msg.id)?.resolve(msg.result)
        pending.delete(msg.id)
        return
      }
      if (!msg.ok && 'error' in msg) {
        pending.get(msg.id)?.reject(new Error(msg.error))
        pending.delete(msg.id)
      }
    })
    child.on('error', err => {
      for (const [, p] of pending) p.reject(err)
      pending.clear()
    })
    child.on('exit', () => {
      child = null
    })
  }
  return child
}

/** Parse in a child process (worker isolate) — keeps the main thread responsive. */
export function parseInWorker(job: ParseJob): Promise<ParseResult> {
  const id = nextId++
  const proc = ensureChild()
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    proc.send({ type: 'parse', job, id } satisfies WorkerRequest)
  })
}

/** Synchronous path for unit tests and tiny edits on the hot path. */
export function parseSync(job: ParseJob): ParseResult {
  return parseIncrementalOrFallback(job)
}

export async function getWorkerStats(): Promise<CacheStats> {
  const id = nextId++
  const proc = ensureChild()
  return new Promise((resolve, reject) => {
    const onMessage = (msg: WorkerResponse) => {
      if (msg.id !== id) return
      proc.off('message', onMessage)
      if (msg.ok && 'stats' in msg) resolve(msg.stats)
      else reject(new Error('stats failed'))
    }
    proc.on('message', onMessage)
    proc.send({ type: 'stats', id })
  })
}

export async function shutdownParserWorker(): Promise<void> {
  if (!child) return
  const id = nextId++
  const proc = child
  await new Promise<void>(resolve => {
    const onMessage = (msg: WorkerResponse) => {
      if (msg.id === id) {
        proc.off('message', onMessage)
        resolve()
      }
    }
    proc.on('message', onMessage)
    proc.send({ type: 'shutdown', id })
  })
  proc.kill()
  child = null
  pending.clear()
}

import { readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MEMWISE_DASH_PORT, MEMWISE_DB_PATH } from '../core/config.js'
import { getDefaultStore } from '../core/db.js'
import type { SqliteStore } from '../store/sqlite-store.js'

function loadDashboardHtml(): string {
  const base = dirname(fileURLToPath(import.meta.url))
  // Resolves from both tsx (src/dashboard/) and compiled (dist/dashboard/)
  const candidates = [
    join(base, 'index.html'),
    join(base, '..', 'src', 'dashboard', 'index.html'),
  ]
  for (const p of candidates) {
    try { return readFileSync(p, 'utf-8') } catch { /* try next */ }
  }
  throw new Error('[memwise] dashboard index.html not found — run `npm run build` or check src/dashboard/')
}

/**
 * On-demand observability viewer (Layer 8.5). Pure Node http — no deps, no daemon. Serves a
 * projects-list + per-project 4-tab page (Normal/Episodic/Semantic/Procedural), a JSON API,
 * and an SSE stream that tails the telemetry table. Launched by `memwise dashboard`.
 */
export interface DashboardOptions {
  store?: SqliteStore
  port?: number
  pollMs?: number
}

function avgEmbedMs(store: SqliteStore): number | null {
  // Pull the recent embed events and average their ms.
  const events = store.queryRecentTelemetry(0, 200).filter(e => e.kind === 'embed')
  if (events.length === 0) return null
  const sum = events.reduce((a, e) => a + (Number(e.payload.ms) || 0), 0)
  return Math.round(sum / events.length)
}

function dbSizeBytes(): number {
  try {
    return statSync(MEMWISE_DB_PATH).size
  } catch {
    return 0
  }
}

export function createDashboard(opts: DashboardOptions = {}): Server {
  const store = opts.store ?? getDefaultStore().store
  const pollMs = opts.pollMs ?? 500
  const clients = new Set<ServerResponse>()
  let lastTelemetryId = 0

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/'

    if (url === '/' || url.startsWith('/index')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
      res.end(loadDashboardHtml())
      return
    }

    if (url.startsWith('/api/projects')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(store.queryProjects()))
      return
    }

    if (url.startsWith('/api/memories')) {
      const params = new URL(url, 'http://localhost').searchParams
      const project = params.get('project') ?? ''
      const tier = params.get('tier') ?? 'normal'
      const limit = Math.min(Number(params.get('limit') ?? 50), 200)
      let data: unknown
      if (tier === 'episodic') {
        data = store.queryRecentSessionSummaries(project, limit)
      } else if (tier === 'normal') {
        data = store.queryRecentMessagesScoped(project, limit)
      } else {
        data = [] // semantic / procedural: populated in M2
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(data))
      return
    }

    if (url.startsWith('/api/recent')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(store.queryRecentMessages(50)))
      return
    }

    if (url.startsWith('/api/stats')) {
      const messages = store.queryRecentMessages(100000).length
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ messages, avgEmbedMs: avgEmbedMs(store), dbSizeBytes: dbSizeBytes() }))
      return
    }

    if (url.startsWith('/events')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }

    res.writeHead(404)
    res.end('not found')
  })

  // Tail telemetry → broadcast new rows to all SSE clients.
  const timer = setInterval(() => {
    if (clients.size === 0) {
      // Still advance the cursor so a freshly-connected client doesn't get a backlog flood.
      const latest = store.queryRecentTelemetry(lastTelemetryId, 500)
      if (latest.length) lastTelemetryId = latest[latest.length - 1]!.id
      return
    }
    const rows = store.queryRecentTelemetry(lastTelemetryId, 500)
    for (const row of rows) {
      lastTelemetryId = row.id
      const data = `data: ${JSON.stringify({ kind: row.kind, payload: row.payload, ts: row.ts })}\n\n`
      for (const c of clients) c.write(data)
    }
  }, pollMs)
  timer.unref?.()

  server.on('close', () => {
    clearInterval(timer)
    for (const c of clients) c.end()
    clients.clear()
  })

  const port = opts.port ?? MEMWISE_DASH_PORT
  server.listen(port)
  return server
}

import { statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { MEMWISE_DASH_PORT, MEMWISE_DB_PATH } from '../config.js'
import { getDefaultStore } from '../db.js'
import type { SqliteStore } from '../store/sqlite-store.js'
import { DASHBOARD_HTML } from './html.js'

/**
 * On-demand observability viewer (Layer 8.5). Pure Node http — no deps, no daemon. Serves one
 * inline page, a recent-messages + stats JSON API, and an SSE stream that tails the telemetry
 * table (poll the newest id, push deltas). Launched by `memwise dashboard`.
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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(DASHBOARD_HTML)
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

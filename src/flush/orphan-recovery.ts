import { ORPHAN_IDLE_S } from '../config.js'
import { listHotSessionIds, sessionLastActivityTs } from '../redis.js'
import type { Flusher } from './flusher.js'

/**
 * Flush sessions idle longer than `idleSeconds` (default ORPHAN_IDLE_S).
 * Layer 9 daemon will call this on an interval; Layer 5 tests invoke it directly.
 */
export async function recoverOrphanSessions(
  flusher: Flusher,
  idleSeconds: number = ORPHAN_IDLE_S,
): Promise<number> {
  const now = Date.now()
  const thresholdMs = idleSeconds * 1000
  const sessionIds = await listHotSessionIds()
  let sessionsFlushed = 0

  for (const sessionId of sessionIds) {
    const lastTs = await sessionLastActivityTs(sessionId)
    if (lastTs === null) continue
    if (now - lastTs <= thresholdMs) continue
    await flusher.flushSession(sessionId)
    sessionsFlushed++
  }

  return sessionsFlushed
}

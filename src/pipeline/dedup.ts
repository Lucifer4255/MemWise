import type { Redis } from 'ioredis'
import { getRedis, hashCaptureEvent } from '../redis.js'
import type { CaptureEvent } from '../types.js'

const DEDUP_PREFIX = 'mw:dedup:'
const DEDUP_TTL_SEC = 300

/** True if this is the first time we've seen this event within the TTL window. */
export async function isNewEvent(
  event: CaptureEvent,
  redis: Redis = getRedis(),
): Promise<boolean> {
  const hash = hashCaptureEvent(event as unknown as Record<string, unknown>)
  const result = await redis.set(`${DEDUP_PREFIX}${hash}`, '1', 'EX', DEDUP_TTL_SEC, 'NX')
  return result === 'OK'
}

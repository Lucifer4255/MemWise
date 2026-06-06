import { MEMORY_EVICT_THRESHOLD, MEMORY_HALFLIFE_DAYS } from './config.js'

/**
 * Memory lifecycle for the durable tiers (semantic facts, procedural patterns).
 *
 * These are NOT inventions — they're long-established, public concepts:
 *   • the Working/Episodic/Semantic/Procedural memory taxonomy → Tulving (1972)
 *   • time-decay of an untouched memory → the Ebbinghaus forgetting curve (1885)
 *   • reinforcement-on-reuse resetting decay → spaced repetition (Leitner / SM-2)
 *   • ranking memories by recency × importance → the Generative Agents "memory stream" (Park 2023)
 * We implement the same public mechanisms; see memory/agentmemory-memory-types.md.
 *
 * Reinforcement (support/freq +1, last_seen = now) is handled in the store upserts. Here we only
 * compute the read-time decay score and the eviction predicate — there is no background daemon.
 */

const DAY_MS = 86_400_000

/**
 * Decay score = (1 + support) · exp(−ageDays / halfLife).
 * `support` (or `freq`) slows decay: a fact re-observed many times survives far longer than a
 * one-off. A freshly-reinforced fact scores high; one untouched for many half-lives fades toward 0.
 */
export function decayScore(
  support: number,
  lastSeen: number,
  now: number = Date.now(),
  halfLifeDays: number = MEMORY_HALFLIFE_DAYS,
): number {
  const ageDays = Math.max(0, (now - lastSeen) / DAY_MS)
  return (1 + support) * Math.exp(-ageDays / halfLifeDays)
}

/** True if a fact/pattern has decayed below the eviction floor and should be pruned at job end. */
export function isEvictable(
  support: number,
  lastSeen: number,
  now: number = Date.now(),
  threshold: number = MEMORY_EVICT_THRESHOLD,
): boolean {
  return decayScore(support, lastSeen, now) < threshold
}

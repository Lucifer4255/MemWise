/**
 * Single source of truth for the embedding model + dimension.
 *
 * The encoder is chosen empirically by the Layer 11 benchmark sweep (spec §2.1),
 * so it lives here in config — NOT hardcoded in the schema or embed client.
 * The vec0 table dimension (store/schema.ts) and the Ollama client (embed/) both
 * read EMBED_DIM, so swapping models is a one-place change (+ a fresh DB if the
 * dimension differs).
 *
 * Default is arctic-embed:33m (384) — fast ~8ms encode, same dim/speed profile as the
 * MiniLM fairness baseline so swapping baseline↔default needs no schema change. The
 * encode cost is on the hot path (capture + query), and MRL truncation does NOT reduce
 * encode time, so we keep the fast small encoder as default and let the §16 sweep promote
 * a heavier one (embeddinggemma/qwen3) only if quality demands it.
 *
 * No code-specific embedder exists in the official Ollama library (verified the catalog).
 * (`nomic-embed-code` is a 7B / ~3584-dim model, not the "274MB/768-dim" it's sometimes
 * mistaken for, and isn't on Ollama — it would break the zero-blocking capture path. Avoid.)
 *
 * Candidate set + roles: spec §2.1.
 *   all-minilm              384            fairness baseline (= agentmemory's encoder)
 *   snowflake-arctic-embed:33m  384        ◆ PROVISIONAL DEFAULT — fast ~8ms encode
 *   nomic-embed-text        768            long-context (8192)
 *   embeddinggemma          768/512/256/128 (MRL)  best on-device quality; MRL dim dial (§14 scan)
 *   qwen3-embedding:0.6b    1024 (MRL)     top quality ceiling, slowest encode
 *
 * Override per-run for the sweep:
 *   MEMWISE_EMBED_MODEL=embeddinggemma MEMWISE_EMBED_DIM=768 npx tsx ...
 */

export const EMBED_MODEL: string = process.env.MEMWISE_EMBED_MODEL ?? 'snowflake-arctic-embed:33m'
export const EMBED_DIM: number = Number(process.env.MEMWISE_EMBED_DIM ?? 384)

export const OLLAMA_URL: string = process.env.MEMWISE_OLLAMA_URL ?? 'http://localhost:11434'

/**
 * Redis hot-window sizing (Layer 3). The window is a per-SESSION sliding buffer of recent
 * chunks; it flushes to the SQLite cold store on eviction (flush-then-delete, never drop).
 *
 * Capped by a TOKEN budget, not a chunk/message count — tokens are what the agents actually
 * burn. Rule of thumb at 384-dim: ~20 bytes of Redis RAM per token (a ~300-token chunk costs
 * ~6 KB: text + vector-in-hash + FLAT-index copy + metadata). So:
 *   1M tokens/session ≈ ~20–27 MB ;  2 agents (Claude + Cursor) ≈ ~40–55 MB.
 * REDIS_MAXMEMORY is a generous backstop (≈2× expected) with noeviction, so a runaway errors
 * loudly instead of silently dropping un-flushed chunks. RAM is never the binding constraint
 * here — the FLAT hot-KNN stays sub-3ms up to ~2M tokens; switch to HNSW only beyond ~5M.
 *
 * TIME dimension — durability comes from ACTIVE flushes, never from TTL expiry. A chunk
 * leaves the window via (1) PreCompact flush, (2) token-budget overflow, or (3) the orphan
 * sweep (session idle > ORPHAN_IDLE_S) — all three go through flush-then-delete. Redis TTL
 * is ONLY a leak backstop: it must stay > ORPHAN_IDLE_S + SWEEP_INTERVAL_S so a live daemon
 * always flushes a chunk before TTL could silently delete it (Redis expiry can't flush — the
 * key is already gone when the event fires). TTL firing un-flushed = daemon dead for 6h.
 * Active sweep + PreCompact flush are Layer 5/9; they MUST reuse the same onEvict path.
 */
export const HOT_WINDOW_MAX_TOKENS: number = Number(process.env.MEMWISE_HOT_WINDOW_MAX_TOKENS ?? 1_000_000)
export const HOT_WINDOW_TTL_S: number = Number(process.env.MEMWISE_HOT_WINDOW_TTL_S ?? 21600) // 6h — backstop only
export const ORPHAN_IDLE_S: number = Number(process.env.MEMWISE_ORPHAN_IDLE_S ?? 7200) // 2h idle → flush session
export const SWEEP_INTERVAL_S: number = Number(process.env.MEMWISE_SWEEP_INTERVAL_S ?? 300) // daemon sweep cadence
export const REDIS_MAXMEMORY: string = process.env.MEMWISE_REDIS_MAXMEMORY ?? '128mb'
export const REDIS_URL: string = process.env.MEMWISE_REDIS_URL ?? 'redis://localhost:6379'

/** Avg tokens per chunk — used to estimate a chunk's token cost when trimming the window. */
export const CHUNK_TOKENS_EST: number = Number(process.env.MEMWISE_CHUNK_TOKENS_EST ?? 300)

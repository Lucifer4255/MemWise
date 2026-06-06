import { homedir } from 'node:os'
import { join } from 'node:path'

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

/** SQLite store path — the single durable store (no Redis; capture writes here directly). */
export const MEMWISE_DB_PATH: string =
  process.env.MEMWISE_DB_PATH ?? join(homedir(), '.memwise', 'memwise.db')

/** Formatter hard cap (spec §12). */
export const RETRIEVE_MAX_TOKENS: number = Number(process.env.MEMWISE_RETRIEVE_MAX_TOKENS ?? 1500)

/** Per-source candidate count before RRF fusion. */
export const RETRIEVE_HYBRID_LIMIT: number = Number(process.env.MEMWISE_RETRIEVE_HYBRID_LIMIT ?? 10)

/**
 * Enrichment (Layer 8). At turn end the captured contextText is rewritten by a local chat model
 * (vague narration → specific prose + per-change why) BEFORE embedding, so the vector is written
 * once over the enriched text. Graceful: if ENRICH_MODEL isn't pulled, enrichment is skipped and
 * the raw text is embedded — capture never hard-fails on a missing model.
 */
export const ENRICH_MODEL: string = process.env.MEMWISE_ENRICH_MODEL ?? 'qwen2.5:3b'
export const ENRICH_TIMEOUT_MS: number = Number(process.env.MEMWISE_ENRICH_TIMEOUT_MS ?? 10_000)
/** Tri-state: 'on' forces, 'off' disables, 'auto' probes /api/tags for ENRICH_MODEL. */
export const ENRICH_ENABLED: 'on' | 'off' | 'auto' =
  (process.env.MEMWISE_ENRICH_ENABLED as 'on' | 'off' | 'auto' | undefined) ?? 'auto'

/** Job 2 episodic consolidation fires once this many new chunks land since the last nightshift row. */
export const EPISODIC_MIN_NEW_CHUNKS: number = Number(process.env.MEMWISE_EPISODIC_MIN_NEW_CHUNKS ?? 10)

/**
 * Semantic (Job 3) & Procedural (Job 4) consolidation thresholds + memory lifecycle (M2).
 * Higher than episodic so they run less often (durable facts/workflows change slowly).
 * Decay/eviction are public concepts (Ebbinghaus forgetting curve, spaced repetition) — see
 * src/enrich/decay.ts and memory/agentmemory-memory-types.md.
 */
export const SEMANTIC_MIN_NEW_CHUNKS: number = Number(process.env.MEMWISE_SEMANTIC_MIN_NEW_CHUNKS ?? 15)
export const PROCEDURAL_MIN_NEW_CHUNKS: number = Number(process.env.MEMWISE_PROCEDURAL_MIN_NEW_CHUNKS ?? 20)
/** Decay half-life in days: a fact untouched this long loses ~half its score (× support weighting). */
export const MEMORY_HALFLIFE_DAYS: number = Number(process.env.MEMWISE_MEMORY_HALFLIFE_DAYS ?? 30)
/** Eviction floor: facts/patterns whose decay score falls below this are pruned at job end. */
export const MEMORY_EVICT_THRESHOLD: number = Number(process.env.MEMWISE_MEMORY_EVICT_THRESHOLD ?? 0.15)

/** Observability dashboard (Layer 8.5) — localhost viewer, launched on demand. */
export const MEMWISE_DASH_PORT: number = Number(process.env.MEMWISE_DASH_PORT ?? 4242)

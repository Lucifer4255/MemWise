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

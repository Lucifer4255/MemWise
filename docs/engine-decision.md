# Engine decision: SQLite vs LadybugDB (Spike #14)

**Date:** 2026-06-20 · **Branch:** `spike/ladybug-graph-db` · **Verdict: KEEP SQLite. Do not migrate.**

## How the decision was made

Not by argument — by racing a full `LadybugStore` (graph-native, Cypher, vector+FTS) against
`SqliteStore` behind the same `MemoryStore` interface, on the same coding-agent-life-v1 dataset with
identical embeddings (`eval/store-bench.ts`). Both stores are real implementations; the only variable
is the engine.

## Results

| Axis | SQLite | Ladybug | Winner |
|------|--------|---------|--------|
| Hit-rate@5 | 1.000 | 1.000 | tie |
| Recall@5 | 1.000 | 1.000 | tie |
| MRR | 0.867 | 0.878 | tie (noise) |
| Ingest 15 sessions | **4.8 ms** | 127 ms | SQLite ~26× |
| Retrieve p50 | **1.06 ms** | 31.1 ms | SQLite ~29× |
| Retrieve p95 | **1.63 ms** | 37.2 ms | SQLite ~23× |
| On-disk size | **1.81 MB** | 2.63 MB | SQLite ~1.45× |

(embeddings pre-warmed so timings are **pure store work**, no Ollama in the timed path.)

## Why SQLite wins *for MemWise specifically*

- **Quality is identical.** A graph engine buys nothing on retrieval quality here — the hybrid
  vector+FTS+RRF + bounded graph expansion already maxes the benchmark on both.
- **The hot path is bounded and small.** MemWise retrieval = top-k vector entry + capped expansion
  (parent chain ≤8, blast ≤3, ≤6 connected chunks). Ladybug's architectural edge (CSR adjacency,
  factorized joins, morsel parallelism) only activates on **deep/large** traversals MemWise doesn't
  do. Meanwhile its per-query Cypher parse/plan overhead (~30 ms, even with prepared statements)
  dominates at this scale, where SQLite's prepared statements cost ~1 ms.
- **Latency + determinism is the product.** A ~30× hot-path regression directly contradicts the
  latency/determinism pitch (vs agentmemory) and the local-first stance.
- **Operational risk.** Ladybug leaves a stale `.wal` after a crash that blocks re-open (DB-ID
  mismatch) — `better-sqlite3` has no equivalent failure mode. Plus: young 2025 fork, single steward,
  vs SQLite's decades of runway. For a store whose job is durable memory, longevity is load-bearing.

## What would flip this

Adopt an embedded graph engine (Ladybug the front-runner) **only if** MemWise grows genuinely
deep/unbounded graph features: arbitrary-length causal-path queries, community detection / global
graph summarization, or graph algorithms over hundreds of thousands of edges. None are in scope.

## Consequences

- **Layer 14 (episodic GraphRAG) proceeds on SQLite** — session nodes, decision nodes,
  summarizes/supersedes edges as the additive schema already planned. SQLite *is* the graph DB here
  (edge tables + recursive CTEs over indexed edges).
- **Keep `LadybugStore` behind the interface** as a documented, working fallback for a future
  deep-graph direction. It cost little (the `MemoryStore` abstraction made it cheap) and proves the
  engine is swappable if the workload ever changes.
- Spike artifacts retained: `src/store/ladybug-store.ts`, `src/store/ladybug-schema.ts`,
  `eval/store-bench.ts`, `spike/`, `docs/spike-ladybug.md`.

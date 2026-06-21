# MemWise

**Local-first memory for AI coding agents that survives compaction and follows you across agents and sessions.**

Your AI never loses the thread — not after `/compact`, not in a brand-new session, not when you switch between Claude Code, Codex, and Cursor. MemWise captures every coding turn the moment it happens, stores it in a local SQLite database that never leaves your machine, and surfaces the right context through two MCP tools your agent calls automatically.

> *git tracks what changed. MemWise tracks why.*

<sub>**Under the hood:** one node per message (a deterministic, git-like "commit object" per turn) in SQLite + `sqlite-vec` + FTS5, retrieved with hybrid search (vector KNN + BM25 + RRF) over a turn/symbol graph. No daemon, no cloud, no rebuild.</sub>

---

## Demo

<!-- Demo video to be attached -->

> 📹 *Demo video coming soon.*

---

## Setup

### Prerequisites

MemWise runs entirely on your machine and depends on a local model runtime — there is **no hosted API**.

| Requirement | Why | Get it |
|---|---|---|
| **Node.js ≥ 20** | runtime | [nodejs.org](https://nodejs.org) |
| **[Ollama](https://ollama.com)**, running | local embeddings + enrichment | `ollama serve` (starts automatically on most installs) |
| Embedding model | semantic search vectors | `ollama pull snowflake-arctic-embed:33m` |
| Enrichment model | turn summaries (optional, degrades gracefully) | `ollama pull qwen2.5:3b` |
| C/C++ build toolchain | native `better-sqlite3` | usually prebuilt; fallback needs `python3` + a compiler (`build-essential` / Xcode CLT / MSVC Build Tools) |

> If Ollama isn't running or the models aren't pulled, capture still works — enrichment falls back to raw summaries and embeddings are skipped until the model is available.

### Install

```bash
npm install -g memwise

memwise init     # writes hooks to ~/.claude/settings.json, ~/.cursor/hooks.json, ~/.codex/settings.json
                 # registers the MCP server with your agent(s)
                 # launches the dashboard at localhost:4242
```

That's it. From here MemWise captures every turn automatically, and your agent calls two MCP tools on its own:

- **`memwise_recent`** — *"catch me up / where did we leave off"* → last N turns + session summary.
- **`memwise_query`** — *"why did we change X", "what's the role of Y"* → hybrid RAG search over past turns, code changes, and the decision chain.

Override the DB path or models anytime:

```bash
MEMWISE_DB_PATH=~/projects/myapp/.memwise.db memwise init
MEMWISE_EMBED_MODEL=embeddinggemma MEMWISE_EMBED_DIM=768 memwise init
```

---

## Benchmarks

### Quality

Run against **coding-agent-life-v1** — [agentmemory](https://github.com/elizaOS/agentmemory)'s *own* coding-recall benchmark — using the **same encoder agentmemory uses (`all-minilm`)**, so any difference is architectural, not a better embedder.

| Metric | MemWise | agentmemory |
|---|---|---|
| **Recall@5** | **1.000** | 0.967 |
| **Hit-rate** | **15/15** | 15/15 |
| **MRR** | 0.867 | — |

MemWise matches or beats the incumbent on its home turf — at parity on recall quality, with the latency and determinism profile below.

```bash
npx tsx eval/coding-agent-life.ts     # reproduce
```

### Speed

Capture and retrieval are single SQLite transactions. Latency stays **flat as the corpus grows** — there's no in-memory index to rebuild.

| Path | p50 | p95 | p99 |
|---|---|---|---|
| `persistMessage` (capture) | 3.8 ms | 4.1 ms | 8.3 ms |
| `retrieve: semantic` | 4.4 ms | 6.8 ms | 7.2 ms |
| `retrieve: recency` | 2.2 ms | 2.7 ms | 3.0 ms |
| `retrieve: session` | 2.4 ms | 3.0 ms | 3.3 ms |

<sub>N=200, 300 seeded rows, mocked embed (~1 ms). Real retrieval adds Ollama embed RTT (~20–80 ms).</sub>

For contrast, agentmemory rebuilds its full in-memory index on every write batch: **177 ms at 240 rows, ~1.7 s at 10k rows**. MemWise's write path doesn't scale with corpus size.

```bash
BENCH_N=500 npx tsx eval/p99.ts       # reproduce
```

---

## License

MIT

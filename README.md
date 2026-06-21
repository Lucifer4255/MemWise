# MemWise

**Local-first memory for AI coding agents that survives compaction and follows you across agents and sessions.**

Your AI never loses the thread — not after `/compact`, not in a brand-new session, not when you switch between Claude Code, Codex, and Cursor. MemWise captures every coding turn the moment it happens, stores it in a local SQLite database that never leaves your machine, and surfaces the right context through two MCP tools your agent calls automatically.

> *git tracks what changed. MemWise tracks why.*

<sub>**Under the hood:** one node per message (a deterministic, git-like "commit object" per turn) in SQLite + `sqlite-vec` + FTS5, retrieved with hybrid search (vector KNN + BM25 + RRF) over a turn/symbol graph. No daemon, no cloud, no rebuild.</sub>

---

## Demo

▶️ **[Watch the demo (Loom)](https://www.loom.com/share/98340a12c7da4f3e97ab2b05a55cf628)**

<!-- TODO: replace with an embedded GIF/thumbnail once recorded -->

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

That's it. From here MemWise captures every turn automatically and your agent calls its MCP tools on its own — see [Usage](#usage).

Override the DB path or models anytime:

```bash
MEMWISE_DB_PATH=~/projects/myapp/.memwise.db memwise init
MEMWISE_EMBED_MODEL=embeddinggemma MEMWISE_EMBED_DIM=768 memwise init
```

---

## Usage

Once `memwise init` has registered the server, **you don't call anything manually** — your agent decides when to pull memory based on the tool descriptions. MemWise exposes three things over MCP (stdio, server name `memwise`):

### Tools (the agent calls these)

| Endpoint | When the agent uses it | What it returns |
|---|---|---|
| **`memwise_recent`** | *"catch me up", "where did we leave off", "what did we do last session"*, or the start of a new session | The last N turns + the latest session summary + active decisions. Time-ordered, no search. |
| **`memwise_query`** | A specific lookup — *"why did we add retry to charge", "what's the role of service Y", "when did we last touch this file"* | Hybrid RAG search (vector + BM25 + graph proximity) over past turns, with code changes, the decision chain, and dependency edges. Reaches **old** sessions by meaning, not just recency. |

Both are **read-only** and take an optional `projectPath` (absolute path) to scope results to one project, plus `limit` (1–50, `memwise_recent` only).

### Prompt (you trigger this)

| Endpoint | How you use it | What it does |
|---|---|---|
| **`/memwise`** | Type it in your agent (optionally with a query: `/memwise why did we drop Redis`) | Pulls project memory into the current turn. Blank → recent worklog; with a query → semantic recall. |

### Manual / scripting

You can also query the store directly from the terminal, independent of any agent:

```bash
memwise query "why did we add retry"     # one-off retrieval from the CLI
memwise dashboard                         # observability UI at localhost:4242
```

---

## Agent support

MemWise captures every coding turn identically across agents — same transcript-on-disk pipeline, same store. The only difference is how each agent's hooks let MemWise build the **session summary**:

| | Claude Code | Codex | Cursor |
|---|---|---|---|
| Turn capture | ✅ transcript at turn end | ✅ transcript at turn end | ✅ transcript at turn end |
| MCP tools (`recent` / `query`) | ✅ | ✅ | ✅ |
| Session summary source | post-compact recap **+** night-shift | night-shift | **night-shift only** |
| First recap available | immediately after a `/compact`, then night-shift | after night-shift (~10 turns) | after night-shift (~10 turns) |

**Why the difference:** Claude Code fires a `PostCompact` hook, so MemWise records the agent's own compaction summary instantly. Cursor exposes no post-compact event, so its session summary is built entirely by night-shift (Job 2) from the per-turn enriched context — which every agent captures equally. The practical effect is only at **cold start**: on a brand-new Cursor project the first recap appears after ~10 turns rather than at the first compaction. Lower `MEMWISE_EPISODIC_MIN_NEW_CHUNKS` to shorten that window.

> Capture quality and retrieval are the same across all three — the post-compact recap is a Claude-only *bonus*, not a dependency.

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
BENCH_N=500 npx tsx bench/p99.ts      # reproduce
```

---

## License

MIT

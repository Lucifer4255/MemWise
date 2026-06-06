---
name: prompt-caching-v2
description: Prompt caching (Anthropic/OpenAI KV cache) for MemWise memory injection — deferred to v2 after M2 ships
metadata:
  type: project
---

Use provider-side KV cache (Anthropic prompt caching, OpenAI automatic prefix caching) to avoid re-encoding the stable memory block on every agent turn.

**Why:** MemWise injects a `## memwise context` block via MCP every turn. The LLM re-encodes it from scratch each time. With caching, first turn pays 1.25×, every subsequent hit pays 0.1× token cost.

**Why deferred:** Cache only pays off for *stable* content. Semantic + Procedural tiers (M2) are the cache candidates — they change rarely (only when consolidation runs). Without M2 there's nothing stable enough to make caching worth it.

**Architecture (when ready):**
- Split MCP output into stable (semantic facts + procedural patterns + latest episodic summary) and dynamic (recent turns + connected history).
- Stable block → write to project CLAUDE.md → lands in system prompt → Anthropic auto-caches repeated system prompt prefixes. No `cache_control` API changes needed from MemWise.
- Dynamic block → stays as tool result / human turn injection (changes every turn, not cacheable).
- For OpenAI/Codex: automatic prefix caching kicks in for prompts ≥1024 tokens — no code change needed, just ensure stable content comes first.

**Per-provider:**
- Claude Code → CLAUDE.md injection (system prompt, auto-cached by Anthropic, 5-min TTL)
- Codex → automatic prefix caching, shared prefix just works
- Cursor → same as above depending on configured model (Claude or GPT-4)

**Files to touch when implementing:** `src/mcp/query-server.ts` (split stable/dynamic), `src/retrieval/formatter.ts` (stable vs dynamic section concept), CLAUDE.md injection logic (new, probably in `src/cli/`).

**Why:** User's idea from a discussion about agentmemory's in-memory index vs MemWise's SQLite approach — realized provider-side KV cache is the right level to implement this, not raw tensor management. See [[project-memwise]].

---
name: agentmemory-memory-types
description: agentmemory's 4-tier memory model (Working/Episodic/Semantic/Procedural) — reference for MemWise dashboard tabs & feature parity
metadata:
  type: reference
---

agentmemory (`am/`) uses a **4-tier memory consolidation** model (README.md §"4-Tier Memory Consolidation", ~line 810), inspired by human sleep consolidation:

| Tier | What | Analogy |
|------|------|---------|
| **Working** | Raw observations from tool use | Short-term memory |
| **Episodic** | Compressed session summaries | "What happened" |
| **Semantic** | Extracted facts and patterns | "What I know" |
| **Procedural** | Workflows and decision patterns | "How to do it" |

Memories decay over time (Ebbinghaus curve); frequently-accessed strengthen; stale auto-evict; contradictions detected/resolved.

**MemWise mapping (today):** MemWise has the spine (one node/message = ~"working/raw" turns) + episodic nightshift summaries. It does NOT yet have explicit Semantic or Procedural tiers — that's a parity gap. The dashboard redesign tabs ("normal" + "episodic") map to spine-turns vs nightshift-summaries. See [[agentmemory-competitive-analysis]] and [[project-memwise]].

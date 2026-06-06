---
name: coding-agent-life-eval-result
description: MemWise matches agentmemory on its own coding-agent-life-v1 retrieval benchmark (R@5 1.0, hit 15/15) — the quality gap is at parity on-domain, not uphill
metadata:
  type: project
---

Ran agentmemory's own `coding-agent-life-v1` benchmark (15 coding sessions, 15 paraphrased queries with goldSessionIds, in `am/eval/data/coding-agent-life-v1/`) against MemWise via `eval/coding-agent-life.ts`.

**Result (real Ollama embeddings, semantic mode, session-level scoring):**
- MemWise: Recall@5 **1.000**, Hit-rate@5 **15/15**, MRR **0.867**, Top-1 gold 11/15, latency p50 17.9ms.
- agentmemory published (same set): hybrid R@5 0.967, hit 15/15, p50 14ms.
- → MemWise is **at parity / slightly ahead on recall**, comparable latency.

**Caveats:** tiny/easy set (both saturate R@5 near ceiling — discriminating signal is MRR/ranking). P@5 not comparable (granularity: MemWise 1 chunk/session → max 0.2; agentmemory chunks finer → 0.578). Adapter ingests sessions as plain chunks, so this measures the **retrieval core (vec+FTS+RRF) only** — bypasses enrichment/AST/graph (those need tool-call transcripts). 4 queries rank gold 2nd not 1st (auth, docker, memory-leak, preferences).

**Why it matters:** [[agentmemory-competitive-analysis]] flagged raw-recall quality as "a conditional/uphill claim." On-domain it's **not uphill — it's at parity**. This is the first real paraphrase-based quality number MemWise has (the bootstrap known-item eval only proved we don't break exact-match recall). The TL;DR-prepend enricher change (verified separately) preserves this. See [[project-memwise]]. Harness: `eval/coding-agent-life.ts` + `eval/run-eval.ts`.

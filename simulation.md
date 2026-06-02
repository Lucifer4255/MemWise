# memwise — Architecture Simulation & Change Canvas

> Purpose: one prompt walked end-to-end through the **current** architecture, as a diagram.
> You annotate it to show me the architecture change you want. I read your marks back.

## How to use this file

Edit the diagrams directly. Mark your intent with this legend so I understand each change:

```
[KEEP]    leave as-is
[CHANGE]  modify this step — write what it should become
[DROP]    remove this step
[NEW]     add a step here
[?]       open question / you're unsure — I'll weigh in
✍️ YOU:   free-text note describing your idea
```

Put a `← [CHANGE] ...` (or other tag) right next to any box/arrow you want to touch.
At the bottom there's a blank **PROPOSED ARCHITECTURE** canvas if you'd rather redraw from scratch.

---

## The example we're simulating

```
USER PROMPT:  "fix the race condition in the payment webhook"
AGENT:        narrates "I'll wrap the handler in a p-limit mutex"
              edits webhook.ts  (adds mutex to handleWebhook)
              runs tests → pass
              closing summary: "webhook.ts — serialized handleWebhook with p-limit mutex"
```

---

## 1. CAPTURE  ⚠️ [SUPERSEDED — §7 is the canonical SPINE model]   ── Layers 2–3

> This diagram shows the OLD per-event / per-segment streaming capture (`textForChunking`,
> `updateChunkSig`, `Segment[]`). The IMPLEMENTED model is the **spine** in §7: one
> `FinalizedMessage` at TURN_END, one vector per message, code → graph children. Kept for contrast.


```
            ┌─────────────────────────────────────────────────────────────┐
 hook  ───► │  adapter (claude-code / codex / cursor)  → CaptureEvent      │
            └─────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
                 ┌──────────────┐  drop Read/Glob/Grep/LS/WebSearch
                 │ filter       │  (shouldCapture) // [1]
                 └──────┬───────┘
                        ▼
                 ┌──────────────┐  Redis SET sha256(event) EX 300 NX
                 │ dedup        │  (isNewEvent)
                 └──────┬───────┘
                        ▼
                 ┌──────────────┐  file_change | command_ran | command_failed
                 │ classify     │  | session_goal | agent_insight | other
                 └──────┬───────┘
                        ▼
        ┌───────────────────────────────────┐
        │ BracketManager.handle(event)       │   builds the turn's structure:
        │   - open bracket on PROMPT         │     · Segment[]  (intent units)
        │   - codeChangeFromToolEvent()      │     · codeChanges[] {file,symbol,type}
        │   - pendingIntent ← NARRATION      │     · intentText  (the "why") //[2]
        │   - close on TURN_END → signature  │
        └───────────────┬───────────────────┘
                        ▼
        ┌───────────────────────────────────┐
        │ textForChunking(event, kind)       │   what becomes a VECTOR:
        │   message?          → text  ✅      │     · conversation (prompt/narration) → vector
        │   file_change       → null  ⛔      │     · code change → NO vector (graph only)
        │   command_*         → null          │       [CHANGE pending: drop "Edited <file>"]
        └───────────────┬───────────────────┘
                        ▼
        ┌───────────────────────────────────┐
        │ chunkText → pushHotChunk()         │   → Redis hot window (embedded=0)
        └───────────────┬───────────────────┘
                        ▼
        ┌───────────────────────────────────┐
        │ on TURN_END: updateChunkSig()      │   stamp each chunk with its segment's sig
        └───────────────────────────────────┘
```



✍️ YOU (capture changes):

> [1] dont drop the read and otehr changes as it will enrich the context of what happened in that message  
> [2] here in recording the messages and turns include context from all first like subagent context summary done by agent  
> and most importantly what i want is i am thinking of sacrifing some quality like i am thinking of storing the code changes and conversation context at the end of the message as i get all the code change and conversation context from segments , sum them up into a single contextual message which will be the link to the code changes on that message against the vector embedding of the message

---

## 2. THE SIGNATURE  (the join key — deterministic, NEVER LLM output)   ── Layer 2

```
sig = sha256( promptText + "\0" + segmentIdx + "\0" + intentText + "\0" + serialize(edits) )

        prompt_sig (sig)  ← the hub
         /        |         \
 context_chunk   change      change          conversation → vector
 (vector, "why") (webhook.ts,(webhook.ts,…)   code        → graph rows
                  handleWebhook)               linked by SAME sig
              ▲
        parent_sig ──► earlier decision turn (DAG lineage)
```

INVARIANT: hash inputs are raw + deterministic. LLM enrichment is an ATTRIBUTE on the row, never hashed.

✍️ YOU (signature changes):

> *write here*

---

## 3. STORE   ── Layers 3 (hot) + 5 (cold)

```
HOT (Redis)                              COLD (SQLite)  ── on PreCompact flush
  mw:chunk:{session}:{seq}  HASH           prompt_sig   (sig, parent_sig, prompt_text, …)
  mw:hot:{session}          ZSET (cap 200) change       (sig, file, symbol, change_type)
  mw:idx                    RediSearch     symbol_dep   (from→to edges, blast radius)
                                           context_chunk(id, sig, text, …)
                                           chunk_vec    (vec0, DIM=EMBED_DIM)
                                           chunk_fts    (fts5 keyword)
```

✍️ YOU (store changes):

> *write here*

---

## 4. RETRIEVE   ── Layer 6

```
query ─► route (heuristic)
           ├─ "continue / where was I" → recency / overview
           ├─ "why does handleWebhook" → graph entry (symbol)
           └─ else                     → semantic anchor
        ─► embed query (Ollama, warm)
        ─► hybrid:  sqlite-vec KNN  +  FTS5 BM25   → RRF fuse → ANCHOR chunk
        ─► follow anchor.sig:
              sig → change → symbols
              symbol → symbol_dep → blast radius
              sig → context_chunk → the "why"
              sig → parent_sig → decision lineage
        ─► assemble ≤1500 tokens → inject
```

✍️ YOU (retrieve changes):

> *write here*

---

## 5. WHAT GETS A VECTOR vs A GRAPH ROW  (current rule)

```
                    has conversation            no conversation
                ┌───────────────────────────┬──────────────────────────┐
 code change    │ vector(conv) + graph(code)│ graph only (no vector)    │
                │ linked by sig             │ ← reachable via symbol/CTE │
                ├───────────────────────────┼──────────────────────────┤
 no code change │ vector(conv) — MUST keep  │ skipped if <40 chars      │
 (text-only)    │ = decision shadow (§6.2)  │                           │
                └───────────────────────────┴──────────────────────────┘
```

✍️ YOU (what-gets-stored changes):

> *write here*

---

## 6. DEFERRED — Intent source ladder (Layer 6, not built yet)

```
take the highest rung present; bottom rung always available:

  Rung 1  per-edit live narration         (best, when given — free)
  Rung 2  closing summary → matched to     (reliable, structured — free)  ← the "distributor"
          the change by file/symbol
  Rung 3  user prompt text                 (almost always present — free)
  Rung 4  structural "modified X in Y"      (ALWAYS derivable from change row — free)

  [OPT-IN] night-shift LLM (gemma3:4b) smooths/enriches — off-path, never the hash
```

✍️ YOU (intent changes):

> *write here*

---

## 7. ⬇ PROPOSED ARCHITECTURE  (redraw / describe your new idea here)

✍️ YOU + reconstructed — the SPINE model (converged)

WHAT CHANGES vs current
- Unit of memory = the MESSAGE (one user prompt), not the per-segment chunk.
- Each message = a PARENT node (spine) + CHILD nodes (code changes).
- Segments become transient (accumulate during the turn); they no longer each get a vector/sig.
- ONE vector per message (the parent), linked to ALL its code changes.

```
PARENT (spine)            one VECTOR ; the "why" ; deterministic sig
  · prompt_text
  · enriched context = closing summary (primary) + narration (fallback) + symbols injected
  · sig = sha256(prompt_text + serialize(all edits))         ← deterministic, NEVER LLM
CHILDREN (code changes)   GRAPH rows only, NO vectors
  · {file, symbol, change_type} + symbol_dep edges (blast radius)
  · inherit the parent's "why" via traversal (no per-symbol summary fabricated)

ROUTING by what was touched
  code file (.ts/.py/.go…)   → child in GRAPH, no vector
  doc/prose file (.md/.txt)  → EMBED its content (the plan's words ARE searchable)   [Insight B]
  conversation               → folded into the parent's enriched context
  reads (Read/Grep/LS/…)     → added to the message's TOUCHED-SET (metadata, not vectors) [Insight A]

CROSS-MESSAGE LINEAGE (parent_sig)
  parent_sig = last stored sig touching this message's TOUCHED-SET (edits ∪ reads)
  → execution(M2) READS plan.md → touched-set overlap → links back to plan(M1)   [Insight A wires it]
  → bound it: prefer strongest/most-recent read as parent; cap fan-out

ASYNC ENHANCER (off-path, triaged)
  after TURN_END (or forced at PreCompact): IF message is "worth it"
  (multi-edit / messy / likely-retrieved) → local LLM denoises the PARENT context → re-embed.
  NEVER touches sig. Skips clean / trivial / soon-evicted messages.

TWO-MESSAGE EXAMPLE
  M1 "design a plan…"  [text + doc]
     PARENT(M1): prompt + plan reasoning → VECTOR ; plan.md content embedded
        └ child: plan.md (DOC → embedded, not graph-only)
              ▲ parent_sig
              │  (M2 READ plan.md → touched-set overlap → links to M1)
  M2 "execute the plan"  [code]
     PARENT(M2): prompt + closing summary "built PaymentService, webhook, idempotency"
                 → VECTOR ; sig=M2 , parent_sig=M1 ; async-enhanced
        ├ child: PaymentService (added)
        ├ child: handleWebhook   (added)
        └ child: IdempotencyKey  (added)

RETRIEVAL = token-efficient (graphify-style)
  inject the code side as a COMPACT SUBGRAPH (edges/triples), NOT code text:
     "handleWebhook (added) --depends_on--> idempotency.ts"   (~8 tok vs pasting the function)
  + the parent's enriched "why" + parent_sig decision chain
  preview + expand-on-demand to keep injected tokens low.

INVARIANTS (unchanged)
  · zero-LLM on capture / blocking path   · sig deterministic, never LLM output
  · stream raw → Redis (compaction-safe) ; finalize the message at TURN_END / forced PreCompact
```

OPEN QUESTIONS for me [?]:
- default-on async enhancer vs opt-in? (changes the "zero-LLM by default" claim + the bench)
- parent_sig fan-out cap when a message reads many files?
- embed full doc-file content, or a capped chunk?


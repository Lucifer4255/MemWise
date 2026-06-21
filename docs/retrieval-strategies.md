# MemWise Retrieval Strategies

Visual map of the current retrieval pipeline and the four GraphRAG strategies layered on top.

---

## 0. Current pipeline (what exists today)

`retrieve()` → `searchAnchors` (vector + FTS) → `expandAnchors` (graph traversal). This is already
hybrid graph-RAG: vector finds entry points, the turn-graph expands context.

```mermaid
flowchart TD
    Q[Query] --> M{mode?}
    M -->|recency / session| RA[searchRecentAnchors]
    M -->|semantic| EMB[embed query] --> SA[searchAnchors\nvector + FTS]
    SA -->|empty| RA
    RA --> ANCH[Anchor turns]
    SA --> ANCH

    ANCH --> EXP[expandAnchors]
    subgraph EXP[expandAnchors - graph traversal]
        direction TB
        C1[getChangesForSig\nfile/symbol/changeType]
        C2[getParentChain\nWhy / causal chain]
        C3[getEdgeNeighbors\nforward/file/symbol edges]
        C4[queryBlastRadius\nsymbol_dep impact]
    end
    EXP --> FMT[formatBundle\ntoken-bounded] --> OUT[Context block]
```

---

## 1. Coarse-to-fine (session-summary nodes) — the dual-route win

Add **Tier-3 session nodes** with their own embedding, edged to member turns. Retrieval matches a
session first (coarse), then drills into only that session's turns (fine). Lets the agent walk a
*whole session / key decisions* without scanning every turn.

```mermaid
flowchart TD
    Q[Query] --> R1[System-1: vector match TURNS\nfast, current searchAnchors]
    Q --> R2[System-2: vector match SESSION nodes\ncoarse-to-fine]

    R2 --> SEL[Select top session]
    SEL -->|summarizes edge| DRILL[Drill into member turns]

    R1 --> FUSE[Merge + dedupe]
    DRILL --> FUSE
    FUSE --> EXP[expandAnchors] --> OUT[Context block]

    subgraph TIERS[Graph tiers]
        direction TB
        T3[Tier 3: Session-summary nodes]
        T2[Tier 2: Decision / fact nodes]
        T1[Tier 1: Turn spine]
        T3 -->|summarizes| T1
        T2 -->|realized_by| T1
    end
```

---

## 2. Decision nodes — promote the "Why" chain to first-class nodes

Today decisions live transiently inside `getParentChain`. Extract them (async / night-shift) into
`decision` nodes so "why did we pick X" is one hop, not a chain walk.

```mermaid
flowchart LR
    subgraph BEFORE[Before - decision is a walk]
        T_a[turn] --> T_b[turn] --> T_c[turn]
        note1[Why = walk parent chain\nand re-read each turn]
    end

    subgraph AFTER[After - decision is a node]
        D[Decision node\n+ embedding]
        D -->|realized_by| Tx[turn]
        D -->|realized_by| Ty[turn]
        D -->|supersedes| D_old[old decision]
        Qd[Query: why X?] --> D
    end
```

---

## 3. RRF fusion — make graph distance a ranking signal

Currently graph proximity only *filters* expansion (capped at 6). Promote it to a ranking signal and
fuse three ranked lists with Reciprocal Rank Fusion.

```mermaid
flowchart TD
    Q[Query] --> V[Vector rank]
    Q --> F[FTS / BM25 rank]
    Q --> G[Graph-proximity rank\nhops from anchor]

    V --> RRF[Reciprocal Rank Fusion\nscore = Σ 1 / k + rank_i]
    F --> RRF
    G --> RRF
    RRF --> TOP[Re-ranked anchors] --> EXP[expandAnchors] --> OUT[Context block]
```

---

## 4. Temporal / supersedes edges — current vs stale facts

When a later decision contradicts an earlier one, add a `supersedes` edge instead of overwriting.
Retrieval filters by validity window so the agent gets the *current* answer.

```mermaid
flowchart LR
    D1[Decision v1\nt=Jan\nuse Redis]
    D2[Decision v2\nt=Mar\ndrop Redis]
    D1 -. supersedes .-> D2

    Q[Query: do we use Redis?] --> FILTER{valid now?}
    FILTER -->|D2 active| ANS[Answer: dropped in Mar]
    FILTER -.->|D1 stale, excluded| X[ignored]
```

---

## All strategies together

How the four layers compose into one retrieval call.

```mermaid
flowchart TD
    Q[Query] --> ENTRY[Entry: System-1 turns + System-2 sessions]

    ENTRY --> RANK[RRF fusion\nvector + FTS + graph-proximity]
    RANK --> TEMP[Temporal filter\ndrop superseded]
    TEMP --> EXP[expandAnchors\nturn-graph + blast radius]
    EXP --> DEC[Attach decision nodes\nrealized_by]
    DEC --> FMT[formatBundle] --> OUT[Context block]

    classDef new fill:#1f6f43,stroke:#0d3,color:#fff
    classDef have fill:#274472,stroke:#69f,color:#fff
    class ENTRY,RANK,TEMP,DEC new
    class EXP,FMT have
```

> Green = new strategies to add · Blue = already built.

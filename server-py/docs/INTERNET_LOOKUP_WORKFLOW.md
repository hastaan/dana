# Unified Internet Lookup — Workflow

Goal: one **native, in-container** internet-research subsystem with three tiers
(**quick · deep look-up · deep search**), wired into every place Dana touches the web, and
made *super robust*. We port only the logic we need from the two reference servers
(`gptr-mcp`, `storm`) and **drop the scaffolding we don't** (MCP transport, FastMCP, the
separate strip-think proxy process, the heavyweight `gpt-researcher` package, nginx/n8n).

> Home: the native module lands in **`server-py`** (Python — where the gptr/STORM logic is
> native and where the future backend lives). The running **TS backend** gets the cheap
> robustness wins (think-strip, SearXNG tolerance, backoff) but not the heavy tiers.

---

## Status

- **Phase A (server-py) — DONE.**
- **Phase A (TS backend) — DONE.** think-strip + tolerant search + source filter ported, so
  the running app benefits from the robustness wins.
- **Phase B — DONE.**
- **Phase C — DONE.** `deep_search` with breadth `clue | topic | article` +
  `/pipeline/deep-research`.
- **Phase D — DONE.** `internet_lookup` facade + tier fallback + SSE traces +
  synthesized-output caching. Party discovery is now grounded via `deep_search(breadth=topic)`.

**Remaining / optional:**
- localfirecrawl fetch (set `FIRECRAWL_URL`).
- frontend UI for `/api/research/lookup`.
- DSPy optimization (deferred — no resolved-forecast data yet).

---

## localfirecrawl (optional, no API key)

Both backends **already** call `FIRECRAWL_URL` → `/v1/scrape` when it is set
(`app/backend/src/tools/external/httpFetch.ts` and
`server-py/src/dana/tools/http_fetch.py`); it sits first in the fetch chain and failures fall
through to the existing fallbacks. No code changes are needed to use it.

To enable a Playwright-grade fetch with **no API key**, run
[localfirecrawl](https://github.com/teelaitila/localfirecrawl) separately and point Dana at it
by setting `FIRECRAWL_URL` (e.g. `http://host.docker.internal:3002`) in `docker-compose`/`.env`.
It is a heavy Chromium stack, so run it **on demand** rather than leaving it up.

---

## SearXNG note

Keep the **broad** default engine set (`use_default_settings: true` + the 7 engines);
**never** narrow it. Breadth spreads load across engines so they don't self-suspend — the app
ran 1900+ searches with **0 empty** on the broad config. The 0-result episodes were caused by
**narrowing** the engine list, not by rate-limits.

---

## 1. Where Dana touches the web today (audit)

Web access happens **only in Discovery + Enrichment**. Forum-prep / Forum / Scoring are
clue-only (no network). Every touchpoint:

| # | Touchpoint | Backend · file | Stage | Today |
|---|-----------|----------------|-------|-------|
| T1 | Grounded researcher answering a persona's question | py `research/engine.py:113`, `research/retriever.py:72` | Discovery | `web_search` snippets + fetch top-2 → `GroundedAnswer` |
| T2 | Per-party enrichment research | py `pipeline/enrichment.py` → same retriever | Enrichment | same as T1 |
| T3 | Discovery agentic research loop | ts `agents/DiscoveryResearcher.ts`, `llm/agenticLoop.ts:61` | Discovery | `web_search` + `fetch_url` tools |
| T4 | Party enrichment / bulk import loops | ts `agents/PartyEnrichmentAgent.ts:187`, `BulkImportAgent.ts:219` | Enrichment | `web_search` (capped per round) |
| T5 | Smart clue extraction from researched URLs | ts `agents/SmartClueExtractor.ts:359,375` | Enrichment | `web_search(q,3)` + fetch top-2 |
| T6 | `gatherResearch` tool | ts `tools/research/gatherResearch.ts:51,78` | Discovery | `web_search(q,3)` + fetch top-2 |
| T7 | Timeline lookup | ts `tools/external/timelineLookup.ts:16` | Enrichment | `web_search(q,8,dateFilter)` |
| T8 | Fact-check a clue | ts `routes/clues.ts:486` `runFactCheck` | Enrichment/manual | `web_search` to verify a claim |
| T9 | Whole-topic comprehensive briefing | *(none today)* | — | — |

Shared primitives:
- **Search:** ts `tools/external/webSearch.ts` and py `tools/web_search.py` — both **SearXNG → scrape-Brave fallback**.
- **Fetch:** ts `tools/external/httpFetch.ts` (Firecrawl→Jina→Readability) and py `tools/http_fetch.py` (Firecrawl→trafilatura→Jina→raw).

---

## 2. The three tiers (formats)

| Tier | What it is | Returns | Latency / cost | LLM |
|------|-----------|---------|----------------|-----|
| **quick** | one SearXNG pass, ranked hits | `[{title,url,snippet,date}]` | <1 s, no LLM | none |
| **deep_lookup** | search → scrape top-K → synthesize a grounded, cited answer to **one question** | `{answer, context, sources[], source_urls[]}` | ~10–60 s, ~1 LLM call + K fetches | 1× |
| **deep_search** | multi-perspective research → synthesis, **parameterized by `breadth`** | `{content (md, [N] cites), sources[], findings[]}` | varies by breadth | many |

`deep_search` is **breadth-parameterized** so the same native engine serves very different
jobs without a 15-min article every time:

| `breadth` | Scope | Persona/turn budget | ~Latency | Used for |
|-----------|-------|---------------------|----------|----------|
| `clue` | one subject/claim | 1 persona · 2 turns · few sources | ~30–90 s | consolidating resources into **one well-grounded clue** |
| `topic` | the whole question | 3 personas · 3 turns | ~2–5 min | **finding parties + what they do** (Discovery seed) |
| `article` | encyclopedic | 3+ personas · 3+ turns · 30+ searches | ~5–15 min | optional long-form briefing (T9) |

`deep_lookup` is exactly what `GroundedResearcher` already does — we harden it and expose it.
`deep_search` extends Dana's **own** `StormResearchEngine` (multi-persona grounded research)
with a breadth knob + a synthesizer — **native**, so it rides our LLM + think-strip directly
(no `knowledge_storm` dependency; see §4).

---

## 3. Touchpoint → tier (the "which part in which format" decision)

| Touchpoint | Tier | Why |
|-----------|------|-----|
| **Party discovery — find parties + what they do** (py `engine._seed_personas`; ts DiscoveryAgent) | **deep_search** `breadth=topic` | parties + agendas deserve thorough multi-perspective research, not a single lookup |
| **Clue consolidation — gather resources into one clue** (py `engine._distill_clues`; ts SmartClueExtractor) | **deep_search** `breadth=clue` | each clue is grounded by a bounded multi-source deep pass, not one snippet |
| T1 grounded Q&A inside Discovery | **deep_lookup** | answer a specific in-conversation question, cited |
| T2 per-party enrichment (stays as-is, enhanced) | **deep_lookup** | one focused research pass per party-question |
| T3 discovery agentic loop (TS) | **deep_lookup** + **quick** for nav | `web_search`→`fetch` becomes one robust `deep_lookup` |
| T4 enrichment / bulk loops (TS) | **deep_lookup** | synthesis over multiple sources |
| T5 smart clue extraction (TS) | **deep_search** `breadth=clue` | this *is* the resources→clue step |
| T6 gatherResearch (TS) | **deep_lookup** | focused research for a sub-question |
| T7 timeline lookup | **quick** | only wants dated hits; no synthesis |
| T8 fact-check a clue | **deep_lookup** (or **quick** for a single fact) | verify a claim across independent sources |
| T9 whole-topic briefing | **deep_search** `breadth=article` *(new, opt-in)* | standalone long-form deliverable |

Net: **quick** = navigation/timeline/single-fact · **deep_lookup** = the per-question workhorse
in Discovery/Enrichment · **deep_search** = party discovery (`topic`), clue consolidation
(`clue`), and the optional briefing (`article`). Enrichment stays structurally as-is, just
enhanced to run on deep_lookup.

---

## 4. Native port — take / drop / format

| From the zips | Decision | Lands as |
|---------------|----------|----------|
| MiniMax **strip-think** proxy (`minimax_proxy.py`) | **port the logic, drop the process** | a response filter in Dana's LM chokepoint — strip `<think>…</think>` from every completion (py `llm/lm.py` + `llm/dspy_lm.py`; ts `llm/proxyClient.ts`) |
| gptr **`quick_search`** | reimplement natively | `internet.quick()` over the hardened `web_search` |
| gptr **`deep_search`** (plan→search→scrape→synthesize) | reimplement the *pattern* natively — **drop the `gpt-researcher` package** | `internet.deep_lookup()` built from Dana's `web_search` + `http_fetch` + a DSPy plan/synthesize module (reuses `GroundedResearcher`) |
| gptr `write_report` | fold into deep_lookup `report=True` | optional long-form synthesis of a deep_lookup |
| STORM **`generate_article`** | **extend Dana's own `StormResearchEngine`** with a `breadth` knob + synthesizer — **drop the `knowledge_storm` package** (Dana already has the multi-persona engine; native = rides our LLM + think-strip, and scales down to `breadth=clue`) | `internet.deep_search(breadth=…)` (`agents/deep_search.py`) |
| FastMCP server / transport, nginx, n8n, Claude-desktop config, Tavily, `gpt-researcher`, `knowledge_storm` | **drop** | — (we use SearXNG + CLIProxyAPI we already run, and Dana's own DSPy engine) |

**All three tiers run on our LLM**: every synthesis/planning call goes through Dana's single
LM chokepoint → CLIProxyAPI (MiniMax via the custom provider), with the ported **`<think>`
stripper** applied to every completion. No tier calls an external LLM or proxy of its own.

Why native, not services: we already run the LLM proxy (CLIProxyAPI) and SearXNG; the MCP
servers would duplicate those and add transport overhead. Porting the *patterns* lets us
reuse Dana's single LM chokepoint, corpus cache, and SSE bus.

---

## 5. Robustness stack (how we make any web search super robust)

Every layer, existing (✓) and to-add (＋):

1. **LLM responses** — ＋strip `<think>` (MiniMax) at the chokepoint; ✓model-availability
   fallback (`resolve_available_model`); ＋port the TS retry/backoff (`[1s,5s,15s]` on 429/5xx)
   into the **Python** LM (py has none today).
2. **Search** — ＋make SearXNG **failure-tolerant**: return partial/empty instead of
   cascading to a Brave **scrape** (the 429 source); ＋`backoff` retry; ＋trim
   `searxng/settings.yml` engines (`keep_only` whitelist, drop DuckDuckGo); demote Brave-scrape
   to genuine last resort; ＋**pace live searches** (`DANA_SEARCH_SPACING_S`, default 1s) so a
   burst from one tier doesn't trip per-engine rate-limit suspensions on a single server IP —
   the dominant cause of empty results under load.
3. **Fetch** — ✓Firecrawl/localfirecrawl → trafilatura → Jina → raw; ＋backoff; ✓paywall
   handling; ＋bounded concurrency on multi-URL fetches.
4. **Source quality** — ＋port STORM's `GENERALLY_UNRELIABLE | DEPRECATED | BLACKLISTED`
   filter (`is_valid_source`) so junk domains never become clues.
5. **Corpus cache** — ✓`research_searches` / `research_pages`; ＋cache deep_lookup answers +
   deep_search briefings too (keyed by query+tier) so re-runs are cheap.
6. **Tier fallback** — ＋if `deep_search` is unavailable/over-budget → `deep_lookup`; if
   `deep_lookup` LLM fails → return `quick` hits. Never hard-fail a research step.
7. **Budgets / timeouts / concurrency** — ✓`analysis_controls` (iterations, per-round caps,
   batch sizes) + `ResearchBudget`; ＋unify under the tier params (below).
8. **Observability** — ✓SSE `error` / `think` / `progress` events; ＋emit per-tier
   `think` traces (sub-questions, sources, fallbacks taken).

---

## 6. The unified interface

`server-py/src/dana/tools/internet/` — one entry point, parameterized:

```python
async def internet_lookup(
    query: str,
    *,
    level: Literal["quick", "deep_lookup", "deep_search"] = "deep_lookup",
    report: bool = False,          # deep_lookup: also write a long-form answer
    # pass-through knobs (per level):
    top_k: int = 5,                # results per search
    fetch_top: int = 2,            # pages to scrape (deep_lookup)
    max_sub_questions: int = 3,    # deep_lookup planning breadth
    max_perspective: int = 3,      # deep_search interviewers
    max_conv_turn: int = 3,        # deep_search Q&A turns
    search_top_k: int = 5,         # deep_search results/question
    time_range: str | None = None, # quick/deep_lookup date filter
    persona: str | None = None,    # bias retrieval toward a viewpoint
    topic_id: str | None = None,   # corpus-cache scoping + SSE emit
) -> dict
# uniform return:
# { status, level, answer?, content?, sources:[{title,url}], source_urls:[],
#   context?, elapsed, tier_fallback?, cached? }
```

Internals: `quick` → `search.run()`; `deep_lookup` → reuse `GroundedResearcher`
(plan sub-Qs → robust search → fetch top-K → `GroundedAnswer`, optional `write_report`);
`deep_search` → `agents/deep_search.py`. All share the robustness stack in §5.

---

## 7. Pipeline integration

- **py Discovery/Enrichment (T1,T2):** `DanaRetriever` / `GroundedResearcher` become thin
  callers of `internet_lookup(level="deep_lookup")`; per-question budget unchanged.
- **ts Discovery/Enrichment (T3–T6,T8):** the agentic `web_search`+`fetch_url` tool pair is
  replaced by a single `deep_lookup` tool (and `quick` for nav). Search/fetch primitives get
  the §5.1–5.3 robustness regardless.
- **T7 timeline:** call `quick` with `time_range`.
- **T9 (new):** optional `POST /api/topics/{id}/pipeline/deep-research` → `deep_search` →
  store the briefing as a high-credibility "research note" clue that seeds Discovery; also
  exposable as a standalone artifact.

---

## 8. Implementation phases

- **A — Robustness foundation (both backends):** think-strip at the chokepoint; SearXNG
  failure-tolerance + backoff + engine-list cleanup; Python LM retry/backoff; source-quality
  filter. *(Fixes today's CAPTCHA/429 cascade immediately.)*
- **B — `deep_lookup` tier (py):** harden `GroundedResearcher` → `internet.deep_lookup`;
  add `quick`; wire T1/T2; corpus-cache answers.
- **C — `deep_search` tier (py):** extend Dana's `StormResearchEngine` with a `breadth` knob
  + synthesizer → `internet.deep_search`; wire **party discovery** (`breadth=topic`) and
  **clue consolidation** (`breadth=clue`); add `/pipeline/deep-research` (`breadth=article`,
  T9); cache results.
- **D — Unify + verify:** the `internet_lookup` facade + tier fallback; SSE traces; tests
  against the MiniMax creds (below). Then point the TS agentic tools at the new primitives.

---

## 9. Config & credentials

```
# LLM (MiniMax, via CLIProxyAPI custom provider — think-strip applied in Dana)
MINIMAX_API_KEY=sk-cp-…              # test cred
OPENAI_LIKE_BASE_URL=https://api.minimax.io/v1
ANTHROPIC_LIKE_BASE_URL=https://api.minimax.io/anthropic
# Engines (already running)
SEARXNG_URL=http://searxng:8080
FIRECRAWL_URL=                        # set to enable Playwright-grade fetch (localfirecrawl)
# Tier knobs (defaults; overridable per call / via analysis_controls)
DANA_DEEP_SEARCH_MAX_PERSPECTIVE=3
DANA_DEEP_SEARCH_TOP_K=5
```

Tiers are parameterized end-to-end (§6), so any caller passes exactly the breadth/depth it
needs, and the robustness stack (§5) applies uniformly.

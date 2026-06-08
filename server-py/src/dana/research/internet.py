"""Unified internet lookup — the native three-tier research facade.

  quick(query)         → ranked SearXNG hits (source-filtered), no LLM
  deep_lookup(query)   → search → scrape top-K → grounded, cited answer to ONE question
  deep_search(...)     → multi-persona research → synthesized cited briefing (see deep_search.py)

All tiers run on Dana's own engine + LM chokepoint (CLIProxyAPI/MiniMax, with `<think>`
stripping) and the Phase-A robustness stack (tolerant search, backoff, source filter, corpus
cache). `internet_lookup()` is the async facade with graceful tier fallback.
"""
from typing import Literal

from ..llm import dspy_lm
from ..rigor.sources import filter_sources
from ..tools.web_search import web_search
from .engine import GroundedResearcher, _fmt_info
from .retriever import DanaRetriever, ResearchBudget

Level = Literal["quick", "deep_lookup", "deep_search"]


# ── quick ───────────────────────────────────────────────────────────────────────
def quick(query: str, top_k: int = 8, language: str | None = None) -> dict:
    """One SearXNG pass → source-filtered ranked hits. No LLM."""
    hits = filter_sources(web_search(query, num_results=top_k, language=language))
    return {
        "status": "success", "level": "quick", "query": query,
        "results": hits, "sources": [{"title": h["title"], "url": h["url"]} for h in hits],
        "source_urls": [h["url"] for h in hits],
    }


# ── deep_lookup (sync — runs DSPy; call via asyncio.to_thread off the loop) ───────
def deep_lookup(
    query: str,
    *,
    topic: str | None = None,
    topic_id: str = "adhoc-lookup",
    top_k: int = 5,
    fetch_top: int = 2,
    max_sub_questions: int = 3,
    persona: str = "",
) -> dict:
    """Search → scrape top-K → synthesize a grounded, cited answer to one question.
    This is the `GroundedResearcher` pattern exposed as a reusable tier."""
    dspy_lm.configure()
    budget = ResearchBudget(max_searches=top_k + 2)
    retriever = DanaRetriever(topic_id, budget, top_k=top_k, fetch_top=fetch_top)
    researcher = GroundedResearcher(retriever, max_queries=max_sub_questions)
    pred = researcher(topic=topic or query, question=query, persona=persona)
    sources = [{"title": i.title, "url": i.url} for i in pred.retrieved]
    return {
        "status": "success", "level": "deep_lookup", "query": query,
        "answer": pred.answer,
        "context": _fmt_info(pred.retrieved),
        "sources": sources,
        "source_urls": [s["url"] for s in sources],
        "source_count": len(sources),
        "searches_used": budget.searches_used,
    }


# ── async facade with graceful tier fallback ─────────────────────────────────────
async def internet_lookup(query: str, *, level: Level = "deep_lookup", **params) -> dict:
    """Run a tier off the event loop. Never hard-fails: on error, degrades a level
    (deep_search → deep_lookup → quick) so a research step always returns something."""
    import asyncio

    order: list[Level] = ["deep_search", "deep_lookup", "quick"]
    start = order.index(level) if level in order else 1
    last_err: Exception | None = None
    for lvl in order[start:]:
        try:
            if lvl == "quick":
                return await asyncio.to_thread(quick, query, params.get("top_k", 8), params.get("language"))
            if lvl == "deep_lookup":
                return await asyncio.to_thread(
                    lambda: deep_lookup(query, **{k: v for k, v in params.items()
                                                  if k in {"topic", "topic_id", "top_k", "fetch_top",
                                                           "max_sub_questions", "persona"}})
                )
            if lvl == "deep_search":
                from .deep_search import deep_search  # lazy: heavier engine
                res = await asyncio.to_thread(
                    lambda: deep_search(query, **{k: v for k, v in params.items()
                                                  if k in {"topic_id", "breadth", "max_personas",
                                                           "max_turns", "top_k"}})
                )
                if start > 0:  # caller asked for a lower tier but we entered the loop here
                    return res
                return res
        except Exception as e:  # noqa: BLE001
            last_err = e
            continue
    return {"status": "error", "level": level, "query": query,
            "message": f"all tiers failed: {last_err}", "results": [], "sources": []}

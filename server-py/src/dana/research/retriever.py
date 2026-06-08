"""DanaRetriever — web search + corpus cache (⇄ agenticLoop.executeBuiltinTool web_search).

STORM's many conversations dedupe through the corpus exactly like the TS agentic loop:
check research_searches first, fall back to live SearXNG, store the result.
"""
import os
import time
from dataclasses import dataclass, field

from ..db import writers
from ..rigor.sources import is_valid_source
from ..tools.http_fetch import http_fetch
from ..tools.web_search import web_search

# Space out LIVE searches so a burst doesn't trip per-engine rate-limit suspensions on a
# single server IP (the dominant cause of empty results under load). Cache hits skip it.
_SEARCH_SPACING_S = float(os.getenv("DANA_SEARCH_SPACING_S", "1.0"))


@dataclass
class Information:
    url: str
    title: str
    snippet: str
    query: str
    persona: str = ""
    content: str = ""  # fetched full-page content (preferred over snippet for grounding)


@dataclass
class ResearchBudget:
    max_searches: int = 24
    searches_used: int = 0
    cache_hits: int = 0

    def can_search(self) -> bool:
        return self.searches_used < self.max_searches


class DanaRetriever:
    def __init__(self, topic_id: str, budget: ResearchBudget, top_k: int = 4, fetch_top: int = 2):
        self.topic_id = topic_id
        self.budget = budget
        self.top_k = top_k
        self.fetch_top = fetch_top  # how many of the top results to fetch full content for

    def _fetch_content(self, infos: list[Information]) -> None:
        """Populate .content for the top results (corpus-cached) so the grounded
        researcher sees real article text, not thin search snippets."""
        for info in infos[: self.fetch_top]:
            cached = writers.corpus_get_page(self.topic_id, info.url)
            if cached:
                info.content = cached["content"]
                continue
            fetched = http_fetch(info.url, max_chars=4000)
            if fetched:
                title, content = fetched
                info.content = content
                try:
                    writers.corpus_store_page(self.topic_id, info.url, title or info.title, content)
                except Exception:  # noqa: BLE001
                    pass

    def retrieve(self, queries: list[str], persona: str = "") -> list[Information]:
        seen: set[str] = set()
        out: list[Information] = []
        did_live = False
        for q in queries:
            q = q.strip()
            if not q:
                continue
            cached = writers.corpus_find_search(self.topic_id, q)
            if cached is not None:
                self.budget.cache_hits += 1
                results = cached
            else:
                if not self.budget.can_search():
                    continue
                if did_live and _SEARCH_SPACING_S > 0:
                    time.sleep(_SEARCH_SPACING_S)  # pace bursts to avoid rate-limit suspensions
                try:
                    results = web_search(q, num_results=self.top_k)
                    self.budget.searches_used += 1
                    did_live = True
                    writers.corpus_store_search(self.topic_id, q, results)
                except Exception:  # noqa: BLE001
                    results = []
            for r in results[: self.top_k]:
                url = r.get("url", "")
                if not url or url in seen or not is_valid_source(url):
                    continue  # skip dupes + known fabrication/spam domains
                seen.add(url)
                out.append(
                    Information(
                        url=url,
                        title=r.get("title", ""),
                        snippet=r.get("snippet", ""),
                        query=q,
                        persona=persona,
                    )
                )
        self._fetch_content(out)
        return out

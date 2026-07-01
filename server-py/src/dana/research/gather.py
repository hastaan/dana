"""Shared bounded research gathering with SSE activity events (⇄ TS gatherResearch.ts +
agenticLoop.ts emit taxonomy).

The TS smart-edit / research / fact-check / update flows ran an agentic web_search+fetch_url
loop that streamed activity to the UI: 🔎 Searching, 📄 Found, 🌐 Fetching, 📦 Corpus hit,
✓ Fetched. The Python port collapsed that into a single silent `_gather_for_query`, so the
activity feed went quiet during smart edits/research. This module restores the events while
keeping the bounded, corpus-aware behavior — and is shared by BOTH clue_intel and party_intel
so party smart-add/edit/merge/split also research with live activity.

`emit` events use ONLY the UI-rendered `think{icon,label,detail}` type, so the existing
PipelineActivityFeed / OperationModal render them unchanged.

Sync — call inside asyncio.to_thread under dspy_lm.lm_context() (web_search/http_fetch block).
"""
from __future__ import annotations

import re
from typing import Callable

from ..db import writers
from ..tools.http_fetch import http_fetch
from ..tools.web_search import web_search

Emit = Callable[[dict], None]


def _noop_emit(_ev: dict) -> None:
    """Silent default so standalone callers (emit=None) are unaffected."""


# Hosts whose pages we never fetch (anti-bot / login-walled social) — use the search snippet
# instead. Ported verbatim from SmartClueExtractor.isFetchable().
_NON_FETCHABLE = ("x.com", "twitter.com", "instagram.com", "facebook.com", "truthsocial.com", "t.me")


def is_fetchable(url: str) -> bool:
    try:
        m = re.match(r"https?://([^/?#]+)", url or "", re.I)
        host = (m.group(1) if m else "").lower()
        return bool(host) and not any(s in host for s in _NON_FETCHABLE)
    except Exception:  # noqa: BLE001
        return False


def gather_research(
    topic_id: str,
    queries: list[str],
    *,
    max_queries: int = 4,
    fetch_per: int = 2,
    fetch_chars: int = 2000,
    max_chars: int = 12000,
    stage: str = "enrichment",
    emit: Emit | None = None,
) -> str:
    """Gather source context for a set of search queries, emitting live activity (⇄ TS
    gatherResearch). BOUNDED: caps `queries` to `max_queries` and fetches the top `fetch_per`
    results per query. Corpus-aware: a <24h cached search is reused (📦), else web_search is
    stored; per result, non-fetchable hosts use the snippet, otherwise a cached page is reused
    (📦) else http_fetch is stored (🌐→✓). Returns the fragments joined by `\\n\\n---\\n\\n`,
    sliced to `max_chars` ("" if nothing gathered)."""
    emit = emit or _noop_emit
    fragments: list[str] = []
    for sq in [q for q in queries if q and q.strip()][:max_queries]:
        try:
            cached_search = writers.corpus_find_search(topic_id, sq, 24.0)
            if cached_search:
                results = cached_search
                emit({"type": "think", "icon": "📦", "label": "Corpus hit", "detail": sq[:100]})
            else:
                emit({"type": "think", "icon": "🔎", "label": "Searching", "detail": sq[:100]})
                results = web_search(sq, 3)
                if results:
                    try:
                        writers.corpus_store_search(topic_id, sq, results, stage)
                    except Exception:  # noqa: BLE001
                        pass
            n = len(results or [])
            emit({"type": "think", "icon": "📄", "label": f"Found {n} result(s)", "detail": sq[:80]})
            for r in (results or [])[:fetch_per]:
                url = r.get("url", "")
                title = r.get("title", "") or url
                snippet = r.get("snippet", "") or ""
                if not is_fetchable(url):
                    if snippet:
                        fragments.append(f"[{title}] ({url})\n{snippet}")
                    continue
                cached = None
                try:
                    cached = writers.corpus_get_page(topic_id, url)
                except Exception:  # noqa: BLE001
                    cached = None
                if cached and cached.get("content"):
                    emit({"type": "think", "icon": "📦", "label": "Corpus hit", "detail": (title or url)[:100]})
                    fragments.append(f"[{cached.get('title') or title}] ({url})\n{cached['content'][:fetch_chars]}")
                    continue
                emit({"type": "think", "icon": "🌐", "label": "Fetching", "detail": (title or url)[:100]})
                fetched = None
                try:
                    fetched = http_fetch(url, fetch_chars)
                except Exception:  # noqa: BLE001
                    fetched = None
                if fetched:
                    ftitle, ftext = fetched
                    emit({"type": "think", "icon": "✓", "label": "Fetched", "detail": (ftitle or title or url)[:100]})
                    fragments.append(f"[{title}] ({url})\n{ftext[:fetch_chars]}")
                    try:
                        writers.corpus_store_page(topic_id, url, ftitle, ftext, stage)
                    except Exception:  # noqa: BLE001
                        pass
                elif snippet:
                    fragments.append(f"[{title}] ({url})\n{snippet}")
        except Exception:  # noqa: BLE001
            continue
    return "\n\n---\n\n".join(fragments)[:max_chars]

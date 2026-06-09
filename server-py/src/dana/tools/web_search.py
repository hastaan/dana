"""Web search (⇄ TS tools/external/webSearch.ts): SearXNG JSON API, Brave HTML fallback.

Sync (called from DSPy modules running in a worker thread).

Robustness (Phase A): SearXNG is the primary path and is **failure-tolerant** — its per-engine
CAPTCHA/403 noise (DuckDuckGo etc.) still leaves results from the engines that answered, so an
empty/partial result is a VALID answer, not a failure. We retry SearXNG with backoff on real
transport/5xx errors, and only fall back to the Brave HTML scrape as a genuine last resort
(it rate-limits/429s hard, which is what caused the old cascade). On total failure we return
`[]` and let the caller (the grounded researcher) emit INSUFFICIENT_EVIDENCE — one bad search
never aborts a run.
"""
import logging
import os
import re
import time

import httpx

from ..config import settings

logger = logging.getLogger("dana.web_search")
_UA = "Mozilla/5.0 (compatible; Dana/1.0; +https://dana.local)"
_BACKOFF = (1.0, 3.0)  # SearXNG transient-error retries
_EMPTY_RETRIES = 2     # extra re-queries when a 200 yields ZERO hits (Tor exit rotation)

# Tokens too common/short to carry topical signal in title/snippet overlap scoring.
_STOPWORDS: frozenset[str] = frozenset({
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are",
    "was", "were", "be", "by", "at", "as", "it", "its", "with", "from", "that",
    "this", "what", "who", "when", "where", "why", "how", "did", "do", "does",
    "vs", "versus", "about", "into", "over", "after", "before", "new",
})
# Wikipedia language-subdomain pattern, e.g. "sv.wikipedia.org", "de.m.wikipedia.org".
_WIKI_LANG_RE = re.compile(r"^([a-z]{2,3})\.(?:m\.)?wikipedia\.org$", re.I)
_WORD_RE = re.compile(r"[a-z0-9]+", re.I)


def _terms(text: str) -> set[str]:
    """Lowercased, stopword-stripped, ≥3-char content tokens of a string."""
    return {t for t in _WORD_RE.findall(text.lower()) if len(t) >= 3 and t not in _STOPWORDS}


def distill_query(query: str, max_terms: int = 6) -> str:
    """Order-preserving keyword distillation of a verbose query (NO LLM, NO network).

    A long natural-language query ("Islamic Republic regime collapse and formation of a new
    Iranian state") makes flaky scrapers (bing's anti-bot fallback) return off-topic junk,
    while a tight keyword query of the same topic returns real hits. This drops stopwords +
    short tokens, dedupes, and keeps the first `max_terms` content words — so callers can fire
    a cheap second search shot. Returns "" if nothing meaningful distills. (Mirrors the
    sub-question decomposition that gpt-researcher/STORM rely on, minus the LLM.)
    """
    seen: set[str] = set()
    out: list[str] = []
    for tok in _WORD_RE.findall(query):
        low = tok.lower()
        if len(low) >= 3 and low not in _STOPWORDS and low not in seen:
            seen.add(low)
            out.append(tok)
            if len(out) >= max_terms:
                break
    return " ".join(out)


def _host(url: str) -> str:
    m = re.match(r"https?://([^/?#]+)", url or "", re.I)
    return (m.group(1) if m else "").lower()


def rerank_results(query: str, results: list[dict], lang: str | None = None) -> list[dict]:
    """Pure, deterministic post-filter over already-fetched results (NO network).

    Scores each hit by query-term overlap in its title/snippet and applies penalties to
    obviously-generic or off-topic hits (bare-entity titles with no query overlap;
    non-`lang` Wikipedia language editions when an english/`lang` bias is requested).
    Stable: equal scores keep the engine's original order.

    Relevance FLOOR: for a query with ≥2 content terms, results that share NO term with the
    query in either title or snippet are dropped — this kills the nonsense an upstream scraper
    sometimes returns (e.g. bing's anti-bot fallback serving "Boots"/Chrome-help links for an
    Iran query). If every result is off-topic we return [] (an honest "no results") rather than
    surface junk. Single-term queries skip the floor (snippets are often sparse).
    """
    qterms = _terms(query)
    if not results:
        return results
    bias = (lang or "").strip().lower() or None

    if len(qterms) >= 2:
        # Scale the bar with query length: a long, specific query that shares only ONE token
        # with a result is usually an acronym/name collision (e.g. "MEK NCRI Maryam Rajavi…"
        # matching a "Methyl Ethyl Ketone" page on "mek" alone, or "Reza Pahlavi…" matching a
        # company called "REZA" on "reza"), so require ≥2 overlapping terms once the query has
        # ≥4 content terms. Short queries keep the ≥1 bar (sparser signal). All-junk → [].
        min_overlap = 2 if len(qterms) >= 4 else 1

        def _overlap_count(res: dict) -> int:
            return len(qterms & (_terms(res.get("title") or "") | _terms(res.get("snippet") or "")))

        results = [r for r in results if _overlap_count(r) >= min_overlap]
        if not results:
            return []

    def score(idx_res: tuple[int, dict]) -> tuple[float, int]:
        idx, res = idx_res
        title = (res.get("title") or "").strip()
        snippet = res.get("snippet") or ""
        tterms = _terms(title)
        sterms = _terms(snippet)
        s = 0.0
        if qterms:
            # Title overlap counts double — it's the strongest topicality signal.
            s += 2.0 * len(qterms & tterms) / len(qterms)
            s += 1.0 * len(qterms & sterms) / len(qterms)
            # Bare-entity title: short, with zero query-term overlap (e.g. generic "Israel").
            if tterms and not (qterms & tterms) and len(tterms) <= 2:
                s -= 1.5
            elif not (qterms & tterms) and not (qterms & sterms):
                s -= 0.5  # title AND snippet both miss every query term
        # Language bias: demote foreign-language Wikipedia editions when a bias is set.
        if bias:
            m = _WIKI_LANG_RE.match(_host(res.get("url", "")))
            if m and m.group(1).lower() != bias:
                s -= 2.0
        return (s, -idx)  # higher score first; original order breaks ties (stable)

    ranked = sorted(enumerate(results), key=score, reverse=True)
    return [res for _, res in ranked]


def web_search(query: str, num_results: int = 5, language: str | None = None) -> list[dict]:
    clean = re.sub(r"site:\S+", "", query, flags=re.I)
    clean = re.sub(r"\s{2,}", " ", clean).strip()
    q = clean or query
    # Optional english/lang bias for re-ranking only (default unset = no bias = old behavior).
    rank_lang = (os.getenv("DANA_SEARCH_LANG") or "").strip().lower() or None

    def _attempt() -> list[dict]:
        """One SearXNG pass with transient-error backoff + a Brave HTML last resort."""
        last_err: Exception | None = None
        for attempt in range(len(_BACKOFF) + 1):
            try:
                return rerank_results(q, _searxng(q, num_results, language), rank_lang)
            except Exception as e:  # noqa: BLE001
                last_err = e
                if attempt < len(_BACKOFF):
                    time.sleep(_BACKOFF[attempt])
        logger.warning("SearXNG failed after retries (%s); trying Brave once", last_err)
        try:
            return rerank_results(q, _brave(query, num_results), rank_lang)
        except Exception as brave_err:  # noqa: BLE001
            logger.warning("web_search degraded to empty (SearXNG: %s; Brave: %s)", last_err, brave_err)
            return []  # tolerant: empty result, never abort the research run

    # When SearXNG is reached through Tor (outgoing.proxies), a 200 with ZERO hits is usually a
    # blocked/slow exit rather than a truly resultless query — re-querying rotates to a fresh
    # circuit. We retry a bounded number of times on empty; a genuinely resultless query still
    # ends empty (honest), it just costs a couple of extra fast passes first.
    out = _attempt()
    for _ in range(_EMPTY_RETRIES):
        if out:
            break
        out = _attempt()
    return out


def _searxng(query: str, num_results: int, language: str | None) -> list[dict]:
    base = settings.searxng_url.rstrip("/")
    params = {"q": query, "format": "json", "pageno": "1"}
    if language and language != "en":
        params["language"] = language
    r = httpx.get(
        f"{base}/search",
        params=params,
        headers={"Accept": "application/json", "User-Agent": _UA},
        timeout=15.0,
    )
    r.raise_for_status()
    out: list[dict] = []
    for res in r.json().get("results", []):
        url = res.get("url", "")
        if not isinstance(url, str) or not url.startswith("http"):
            continue
        out.append(
            {
                "title": (res.get("title") or "").strip(),
                "url": url,
                "snippet": (res.get("content") or "").strip(),
                "date": res.get("publishedDate"),
            }
        )
        if len(out) >= num_results:
            break
    return out


def _brave(query: str, num_results: int) -> list[dict]:
    # Minimal HTML fallback; SearXNG is the primary path. Parses Brave result blocks.
    r = httpx.get(
        "https://search.brave.com/search",
        params={"q": query},
        headers={"User-Agent": _UA, "Accept": "text/html"},
        timeout=15.0,
        follow_redirects=True,
    )
    r.raise_for_status()
    html = r.text
    out: list[dict] = []
    for m in re.finditer(r'<a[^>]+href="(https?://[^"]+)"[^>]*>(.*?)</a>', html):
        url, title = m.group(1), re.sub(r"<[^>]+>", "", m.group(2)).strip()
        if title and "brave.com" not in url:
            out.append({"title": title, "url": url, "snippet": "", "date": None})
        if len(out) >= num_results:
            break
    if not out:
        raise RuntimeError("no Brave results parsed")
    return out

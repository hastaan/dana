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
import re
import time

import httpx

from ..config import settings

logger = logging.getLogger("dana.web_search")
_UA = "Mozilla/5.0 (compatible; Dana/1.0; +https://dana.local)"
_BACKOFF = (1.0, 3.0)  # SearXNG transient-error retries


def web_search(query: str, num_results: int = 5, language: str | None = None) -> list[dict]:
    clean = re.sub(r"site:\S+", "", query, flags=re.I)
    clean = re.sub(r"\s{2,}", " ", clean).strip()
    q = clean or query
    last_err: Exception | None = None
    for attempt in range(len(_BACKOFF) + 1):
        try:
            return _searxng(q, num_results, language)  # 200 → results (possibly empty) is success
        except Exception as e:  # noqa: BLE001
            last_err = e
            if attempt < len(_BACKOFF):
                time.sleep(_BACKOFF[attempt])
    logger.warning("SearXNG failed after retries (%s); trying Brave once", last_err)
    try:
        return _brave(query, num_results)
    except Exception as brave_err:  # noqa: BLE001
        logger.warning("web_search degraded to empty (SearXNG: %s; Brave: %s)", last_err, brave_err)
        return []  # tolerant: empty result, never abort the research run


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

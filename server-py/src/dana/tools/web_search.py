"""Web search (⇄ TS tools/external/webSearch.ts): SearXNG JSON API, Brave HTML fallback.

Sync (called from DSPy modules running in a worker thread).
"""
import re

import httpx

from ..config import settings

_UA = "Mozilla/5.0 (compatible; Dana/1.0; +https://dana.local)"


def web_search(query: str, num_results: int = 5, language: str | None = None) -> list[dict]:
    clean = re.sub(r"site:\S+", "", query, flags=re.I)
    clean = re.sub(r"\s{2,}", " ", clean).strip()
    try:
        return _searxng(clean or query, num_results, language)
    except Exception as searx_err:  # noqa: BLE001
        try:
            return _brave(query, num_results)
        except Exception as brave_err:  # noqa: BLE001
            raise RuntimeError(
                f"web_search failed: SearXNG: {searx_err}; Brave: {brave_err}"
            ) from brave_err


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

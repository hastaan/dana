"""Page fetch (⇄ TS tools/external/httpFetch.ts): Firecrawl → Jina → raw+strip.

Gives the grounded researcher real content instead of thin search snippets. Sync.
"""
import re

import httpx

from ..config import settings

_UA = "Mozilla/5.0 (compatible; Dana/1.0)"
_JINA = "https://r.jina.ai/"


def http_fetch(url: str, max_chars: int = 4000) -> tuple[str, str] | None:
    """Return (title, content) or None."""
    # 1. Firecrawl (if configured)
    if settings.firecrawl_url:
        try:
            r = httpx.post(
                f"{settings.firecrawl_url.rstrip('/')}/v1/scrape",
                json={"url": url, "formats": ["markdown"], "onlyMainContent": True},
                timeout=45.0,
            )
            if r.status_code == 200:
                data = (r.json() or {}).get("data", {})
                content = (data.get("markdown") or "").strip()
                if content:
                    return (data.get("metadata", {}).get("title") or url), content[:max_chars]
        except Exception:  # noqa: BLE001
            pass

    # 2. Direct GET + trafilatura main-content extraction (clean article text, no chrome)
    html = None
    try:
        r = httpx.get(url, headers={"User-Agent": _UA, "Accept": "text/html"}, timeout=15.0, follow_redirects=True)
        if r.status_code == 200:
            html = r.text
            import trafilatura

            txt = trafilatura.extract(html, include_comments=False, include_tables=False, favor_recall=True)
            if txt and len(txt.strip()) > 250:
                return url, txt.strip()[:max_chars]
    except Exception:  # noqa: BLE001
        pass

    # 3. Jina reader (hosted, no key)
    try:
        r = httpx.get(f"{_JINA}{url}", headers={"Accept": "application/json", "User-Agent": _UA}, timeout=20.0)
        if r.status_code == 200:
            data = (r.json() or {}).get("data", {})
            content = (data.get("content") or "").strip()
            if content:
                return (data.get("title") or url), content[:max_chars]
    except Exception:  # noqa: BLE001
        pass

    # 4. Raw strip-tags (last resort)
    if html:
        stripped = re.sub(r"<(script|style)\b.*?</\1>", " ", html, flags=re.S | re.I)
        text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", stripped)).strip()
        if len(text) > 250:
            return url, text[:max_chars]

    return None

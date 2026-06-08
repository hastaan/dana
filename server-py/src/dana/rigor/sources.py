"""Source-quality filter (⇄ STORM `is_valid_source`, but scoped for an ADVERSARIAL tool).

STORM blocks "generally unreliable" sources for Wikipedia-style neutrality — including state
and partisan media. Dana is the opposite: to analyze a conflict it must HEAR every party's
own voice (state media, partisan outlets) and let the credibility scorer weight it down. So
this filter drops ONLY clear fabrication / hoax / SEO-spam / malware domains that carry no
analytical signal — never legitimate-but-biased outlets.

Conservative by design: when in doubt, let a source through (it gets a low credibility score
elsewhere) rather than silently erase a party's primary voice.
"""
from urllib.parse import urlparse

# Fabrication / hoax / conspiracy content-mills and known SEO/scam farms. NOT state or
# partisan media (those are valid evidence here, scored for credibility downstream).
UNRELIABLE_DOMAINS: frozenset[str] = frozenset({
    "infowars.com", "beforeitsnews.com", "naturalnews.com", "yournewswire.com",
    "newspunch.com", "worldnewsdailyreport.com", "empirenews.net", "nationalreport.net",
    "theonion.com", "babylonbee.com", "clickhole.com",  # satire — not factual evidence
    "globalresearch.ca", "veteranstoday.com", "thegatewaypundit.com", "dailybuzzlive.com",
    "react365.com", "channel45news.com", "now8news.com", "huzlers.com",
})


def domain_of(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").replace("www.", "").lower()
    except Exception:  # noqa: BLE001
        return ""


def is_valid_source(url: str) -> bool:
    """False only for known fabrication/hoax/spam domains; True otherwise."""
    if not url or not url.startswith("http"):
        return False
    netloc = domain_of(url)
    if not netloc:
        return False
    return not any(netloc == d or netloc.endswith("." + d) for d in UNRELIABLE_DOMAINS)


def filter_sources(results: list[dict], url_key: str = "url") -> list[dict]:
    """Drop results whose URL fails is_valid_source (keeps order)."""
    return [r for r in results if is_valid_source(r.get(url_key, ""))]

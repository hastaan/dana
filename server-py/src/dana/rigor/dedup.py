"""Evidence-independence dedup (⇄ TS ScenarioScorer.independentDensity, Enh 4e).

Cluster clues by PRIMARY source domain (not union-on-any-shared-domain — that over-merges
and makes the scorer under-confident; this was a fixed review finding). Independent density
= sum over clusters of the strongest clue's effective weight. Pure Python — never LLM'd.
"""
from urllib.parse import urlparse


def _domain(url: str) -> str:
    try:
        return urlparse(url).hostname.replace("www.", "").lower() if url else ""
    except Exception:  # noqa: BLE001
        return ""


def effective_weight(credibility: int, relevance: int, bias_flags: int = 0) -> float:
    penalized = max(10, credibility - bias_flags * 5)
    return round(penalized * (relevance / 100) * 10) / 10


def independent_density(clues: list[dict]) -> dict:
    """clues: [{credibility, relevance, sources:[url], bias_flags?}]. Returns raw vs
    independence-adjusted density + cluster count."""
    cluster_max: dict[str, float] = {}
    raw = 0.0
    for i, c in enumerate(clues):
        ew = effective_weight(c.get("credibility", 50) or 50, c.get("relevance", 50) or 50, len(c.get("bias_flags", [])))
        raw += ew
        sources = c.get("sources") or []
        key = _domain(sources[0]) if sources else ""
        key = key or f"__solo_{i}"
        cluster_max[key] = max(cluster_max.get(key, 0.0), ew)
    return {
        "raw_density": round(raw, 1),
        "independent_density": round(sum(cluster_max.values()), 1),
        "source_clusters": len(cluster_max),
    }

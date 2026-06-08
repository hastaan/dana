"""Deep-research stage (workflow T9): a long-form `deep_search` briefing on the whole topic,
stored as a high-credibility research-note clue that can seed/inform the rest of the pipeline.

Standalone — does not alter Discovery. Status is left unchanged (it's an augmentation, runnable
before or after Discovery). DSPy runs in a worker thread.
"""
import asyncio

from ..db import writers
from ..events.bus import bus
from ..llm import steering
from ..research.deep_search import deep_search


async def run_deep_research(topic_id: str, title: str, description: str, breadth: str = "article") -> dict:
    def emit(ev: dict) -> None:
        bus.emit(topic_id, ev)

    subject = f"{title}. {description}".strip() + await steering.steering_for(topic_id, "research")
    emit({"type": "progress", "stage": "deep_research", "pct": 0.0, "msg": "Deep research…"})

    def _work() -> dict:
        return deep_search(subject, breadth=breadth, topic_id=topic_id)

    res = await asyncio.to_thread(_work)

    clue = {
        "title": f"Research briefing: {title}"[:120],
        "summary": (res.get("content") or "")[:4000],
        "clue_type": "analysis", "relevance": 80, "credibility": 70,
        "source_urls": res.get("source_urls", [])[:12],
        "source_outlets": [s["title"] for s in res.get("sources", [])[:12]],
        "key_points": [], "change_note": f"deep_search briefing ({breadth})",
    }
    try:
        writers.add_clue(topic_id, clue)
        emit({"type": "clue_discovered", "clue": {"title": clue["title"]}})
    except Exception as e:  # noqa: BLE001
        emit({"type": "think", "icon": "⚠", "label": "briefing store failed", "detail": str(e)[:80]})

    emit({"type": "progress", "stage": "deep_research", "pct": 1.0,
          "msg": f"Deep research complete — {len(res.get('sources', []))} sources"})
    emit({"type": "stage_complete", "stage": "deep_research"})
    return res

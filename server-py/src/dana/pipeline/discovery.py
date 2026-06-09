"""Discovery stage (⇄ TS gatedPipeline.runDiscoverStage): STORM research → parties + clues.

Status flow: draft/* -> discovery -> review_parties. The heavy DSPy program runs in a
worker thread (asyncio.to_thread) so it never blocks the event loop / SSE delivery.
"""
import asyncio
import os

from ..db import writers
from ..events.bus import bus
from ..llm import dspy_lm, steering
from ..research.engine import ResearchConfig, StormResearchEngine


async def run_discovery(topic_id: str, title: str, description: str, cfg: ResearchConfig | None = None) -> dict:
    def emit(ev: dict) -> None:
        bus.emit(topic_id, ev)

    description = (description or "") + await steering.steering_for(topic_id, "research")
    writers.set_topic_status(topic_id, "discovery")
    emit({"type": "progress", "stage": "discovery", "pct": 0.0, "msg": "Starting discovery…"})

    def _work() -> dict:
        with dspy_lm.lm_context():  # thread-local LM for this worker thread
            engine = StormResearchEngine(topic_id, cfg)
            return engine.run(title, description, emit)

    result = await asyncio.to_thread(_work)

    # Optional (workflow: "gather resources into one clue → deep research"): deepen the top
    # clues with a bounded deep_search[clue] pass. Off by default — it's ~30-90 s/clue; enable
    # with DANA_DEEP_CLUES=1. Gracefully no-ops when search is unavailable.
    if os.getenv("DANA_DEEP_CLUES", "0") == "1" and result.get("clues"):
        n = int(os.getenv("DANA_DEEP_CLUES_TOP", "5"))

        def _deepen() -> None:
            from ..research.deep_search import deep_search
            with dspy_lm.lm_context():
                for clue in result["clues"][:n]:
                    subject = clue.get("title") or (clue.get("summary", "")[:80])
                    try:
                        ds = deep_search(subject, breadth="clue", topic_id=topic_id)
                    except Exception:  # noqa: BLE001
                        continue
                    if ds.get("content"):
                        clue["summary"] = (clue.get("summary", "") + "\n\nDeep research: "
                                           + ds["content"][:1500]).strip()
                        urls = list(dict.fromkeys(clue.get("source_urls", []) + ds.get("source_urls", [])))
                        clue["source_urls"] = urls[:10]

        await asyncio.to_thread(_deepen)
        emit({"type": "think", "icon": "🔬", "label": "Clue deep-research",
              "detail": f"deepened up to {n} clues"})

    # Persist parties + clues.
    writers.set_parties(topic_id, result["parties"])
    for clue in result["clues"]:
        try:
            writers.add_clue(topic_id, clue)
        except Exception as e:  # noqa: BLE001
            emit({"type": "think", "icon": "⚠", "label": "clue store failed", "detail": str(e)[:80]})

    writers.set_topic_status(topic_id, "review_parties")
    emit({"type": "weight_result",
          "parties": [{"name": p["name"], "weight": p.get("weight", 0)} for p in result["parties"]]})
    emit({"type": "progress", "stage": "discovery", "pct": 1.0,
          "msg": f"Discovery complete — {len(result['parties'])} parties, {len(result['clues'])} clues "
                 f"({result['searches_used']} searches, {result['cache_hits']} cache hits)"})
    emit({"type": "stage_complete", "stage": "discovery"})
    return result

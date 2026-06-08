"""Discovery stage (⇄ TS gatedPipeline.runDiscoverStage): STORM research → parties + clues.

Status flow: draft/* -> discovery -> review_parties. The heavy DSPy program runs in a
worker thread (asyncio.to_thread) so it never blocks the event loop / SSE delivery.
"""
import asyncio

from ..db import writers
from ..events.bus import bus
from ..llm import dspy_lm
from ..research.engine import ResearchConfig, StormResearchEngine


async def run_discovery(topic_id: str, title: str, description: str, cfg: ResearchConfig | None = None) -> dict:
    def emit(ev: dict) -> None:
        bus.emit(topic_id, ev)

    writers.set_topic_status(topic_id, "discovery")
    emit({"type": "progress", "stage": "discovery", "pct": 0.0, "msg": "Starting discovery…"})

    def _work() -> dict:
        dspy_lm.configure()  # configure the DSPy LM (sync) in this worker thread
        engine = StormResearchEngine(topic_id, cfg)
        return engine.run(title, description, emit)

    result = await asyncio.to_thread(_work)

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

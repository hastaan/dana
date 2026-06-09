"""Enrichment stage (⇄ TS gatedPipeline.runEnrichStage): deeper per-party research.

Runs the STORM engine's enrichment path over the EXISTING parties, distilling delta clues
(deduped against what's already stored). Status flow: review_parties -> enrichment ->
review_enrichment. DSPy runs in a worker thread.
"""
import asyncio

from ..db import reads, writers
from ..events.bus import bus
from ..llm import dspy_lm, steering
from ..research.engine import ResearchConfig, StormResearchEngine


async def run_enrichment(topic_id: str, title: str, description: str, cfg: ResearchConfig | None = None) -> dict:
    def emit(ev: dict) -> None:
        bus.emit(topic_id, ev)

    description = (description or "") + await steering.steering_for(topic_id, "research")
    writers.set_topic_status(topic_id, "enrichment")
    emit({"type": "progress", "stage": "enrichment", "pct": 0.0, "msg": "Enriching parties…"})

    parties = await reads.list_parties(topic_id)
    existing = await reads.list_clues(topic_id)
    seen_titles = {(c.get("title") or "").strip().lower() for c in existing}

    def _work() -> dict:
        with dspy_lm.lm_context():
            engine = StormResearchEngine(topic_id, cfg)
            return engine.enrich(title, description, parties, emit)

    result = await asyncio.to_thread(_work)

    added = 0
    for clue in result["clues"]:
        if (clue.get("title") or "").strip().lower() in seen_titles:
            continue
        try:
            writers.add_clue(topic_id, clue)
            seen_titles.add((clue.get("title") or "").strip().lower())
            added += 1
        except Exception as e:  # noqa: BLE001
            emit({"type": "think", "icon": "⚠", "label": "clue store failed", "detail": str(e)[:80]})

    total = writers.count_clues(topic_id)
    writers.set_topic_status(topic_id, "review_enrichment")
    emit({"type": "progress", "stage": "enrichment", "pct": 1.0,
          "msg": f"Enrichment complete — +{added} clues ({total} total, {result['searches_used']} searches)"})
    emit({"type": "stage_complete", "stage": "enrichment"})
    return {"added": added, "total_clues_after": total}

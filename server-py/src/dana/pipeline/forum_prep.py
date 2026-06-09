"""Forum-prep stage (⇄ TS gatedPipeline.runForumPrepStage): weights + representatives.

Status flow: review_enrichment/review_parties -> forum_prep -> review_forum_prep.
The DSPy program runs in a worker thread (never blocks the loop/SSE).
"""
import asyncio

from ..agents.forum_prep import FACTORS, ForumPrep, final_weight, pentagon_weight, speaking_budget
from ..db import reads, writers
from ..events.bus import bus
from ..llm import dspy_lm
from ..rigor.dedup import independent_density
from .scoring import _evidence_str, _parties_str


async def run_forum_prep(topic_id: str, title: str, description: str) -> dict:
    def emit(ev: dict) -> None:
        bus.emit(topic_id, ev)

    writers.set_topic_status(topic_id, "forum_prep")
    emit({"type": "progress", "stage": "forum_prep", "pct": 0.0, "msg": "Generating forum representatives…"})

    parties = await reads.list_parties(topic_id)
    clues = await reads.list_clues(topic_id)
    density = independent_density(
        [{"credibility": c.get("credibility") or 50, "relevance": c.get("relevance") or 50,
          "bias_flags": c.get("bias_flags") or [], "sources": c.get("sources") or []} for c in clues]
    )
    topic_str = f"{title}\n{description}".strip()
    parties_str = "\n".join(
        f"- {p['id']} | {p['name']} ({p.get('type', '?')}): {p.get('agenda') or p.get('description') or '—'}"
        for p in parties
    ) or "(none)"
    evidence_str = _evidence_str(clues, density)

    def _work() -> dict:
        with dspy_lm.lm_context():
            pred = ForumPrep()(topic=topic_str, parties_str=parties_str, evidence_str=evidence_str)
            return {
                "weights": [w.model_dump() for w in pred.weights],
                "representatives": [r.model_dump() for r in pred.representatives],
            }

    emit({"type": "progress", "stage": "forum_prep", "pct": 0.4, "msg": "Assessing party weights…"})
    out = await asyncio.to_thread(_work)

    # Persist weights (pentagon area of the 5 factors), keyed by party_id.
    by_id = {p["id"]: p for p in parties}
    weight_of: dict[str, float] = {}
    for w in out["weights"]:
        pid = w["party_id"]
        if pid not in by_id:
            continue
        factors = {f: w.get(f, 0) for f in FACTORS}
        wt = pentagon_weight(factors)
        weight_of[pid] = wt
        evidence = {f: w.get("justification", "") for f in FACTORS}
        writers.update_party_weight(topic_id, pid, wt, factors, evidence)
    # Parties the model skipped keep a small default so they still get a speaking floor.
    for p in parties:
        weight_of.setdefault(p["id"], p.get("weight") or 10.0)

    total_weight = sum(weight_of.values()) or 1.0
    reps = []
    for r in out["representatives"]:
        pid = r["party_id"]
        if pid not in by_id:
            continue
        wt = weight_of.get(pid, 10.0)
        rep = {
            "id": f"rep-{pid}", "party_id": pid,
            "persona_title": r.get("persona_title", "") or by_id[pid]["name"],
            "persona_prompt": r.get("persona_prompt", ""),
            "speaking_weight": wt,
            "speaking_budget": speaking_budget(wt, total_weight),
            "auto_generated": True,
        }
        reps.append(rep)
        emit({"type": "think", "icon": "🎭", "label": f"Representative · {by_id[pid]['name']}",
              "detail": f"{rep['persona_title']} · weight {wt}"})
    # Any party without a generated rep gets a minimal fallback so the forum is complete.
    have = {r["party_id"] for r in reps}
    for p in parties:
        if p["id"] not in have:
            wt = weight_of[p["id"]]
            reps.append({
                "id": f"rep-{p['id']}", "party_id": p["id"],
                "persona_title": p["name"], "persona_prompt": f"You represent {p['name']}: {p.get('agenda', '')}",
                "speaking_weight": wt, "speaking_budget": speaking_budget(wt, total_weight),
                "auto_generated": True,
            })

    writers.save_representatives(topic_id, reps)
    writers.set_topic_status(topic_id, "review_forum_prep")
    emit({"type": "weight_result",
          "parties": sorted(([{"name": by_id[r['party_id']]['name'], "weight": r["speaking_weight"]}
                              for r in reps]), key=lambda x: x["weight"], reverse=True)})
    emit({"type": "progress", "stage": "forum_prep", "pct": 1.0,
          "msg": f"Forum prep complete — {len(reps)} representatives"})
    emit({"type": "stage_complete", "stage": "forum_prep"})
    return {"representatives": reps, "weights": weight_of}

"""Scoring stage (⇄ TS gatedPipeline.runScoringStage): clues + parties → ranked verdict.

Phase 2 "forum-lite": instead of a multi-turn debate we synthesize the candidate scenarios
straight from the parties' agendas + the evidence, then score them. Status flow mirrors the
TS contract exactly: * -> expert_council (working) -> complete. The DSPy program runs in a
worker thread so it never blocks the loop / SSE.
"""
import asyncio

from ..agents.scenario_scorer import ScenarioScorer
from ..db import reads, writers
from ..events.bus import bus
from ..llm import dspy_lm, steering
from ..rigor.dedup import effective_weight, independent_density
from . import state_manager


def _parties_str(parties: list[dict]) -> str:
    if not parties:
        return "(no parties identified)"
    return "\n".join(
        f"- {p['name']} ({p.get('type', '?')}): {p.get('agenda') or p.get('description') or '—'}"
        for p in parties
    )


def _evidence_str(clues: list[dict], density: dict) -> str:
    lines = []
    _SKIP = ("", "none", "no significant counter-evidence found")
    for i, c in enumerate(clues[:25], 1):
        n = len(c.get("sources") or [])
        ew = effective_weight(c.get("credibility") or 50, c.get("relevance") or 50,
                              len(c.get("bias_flags") or []))
        verdict = c.get("verdict") or "unchecked"
        flags = ", ".join(c.get("bias_flags") or []) or "none"
        lines.append(
            f"[{i}] {c.get('title', '')} (effective_weight {ew}, credibility "
            f"{c.get('credibility')}, relevance {c.get('relevance')}, {n} source(s), "
            f"verdict={verdict}, bias_flags={flags}): {c.get('summary', '')[:300]}"
        )
        counter = (c.get("counter_evidence") or "").strip()
        if counter and counter.lower() not in _SKIP:
            lines.append(f"  COUNTER-EVIDENCE: {counter[:160]}")
        cui = (c.get("cui_bono") or "").strip()
        if cui and cui.lower() not in _SKIP:
            lines.append(f"  CUI BONO: {cui[:120]}")
    note = (
        f"\nSource-independence: use the INDEPENDENT density ({density['independent_density']}) "
        f"across {density['source_clusters']} distinct source-cluster(s), NOT the raw density "
        f"({density['raw_density']}). Corroboration spanning more independent clusters is stronger; "
        f"a single cluster (one wire echoed by many outlets) is weak. effective_weight is the "
        f"primary per-clue weight (credibility x relevance, bias-penalized)."
    )
    return ("\n".join(lines) or "(no evidence gathered)") + note


def forum_evidence_str(clues: list[dict], limit: int = 30) -> str:
    """Evidence list keyed by REAL clue ids so representatives can cite them."""
    lines = [
        f"- {c['id']}: {c.get('title', '')} (cred {c.get('credibility')}): {c.get('summary', '')[:220]}"
        for c in clues[:limit]
    ]
    return "\n".join(lines) or "(no evidence gathered)"


async def run_scoring(topic_id: str, title: str, description: str) -> dict:
    def emit(ev: dict) -> None:
        bus.emit(topic_id, ev)

    writers.set_topic_status(topic_id, "expert_council")
    version = await asyncio.to_thread(
        state_manager.get_or_allocate_version, topic_id, fork_stage="expert_council")
    out = await score_into_version(topic_id, title, description, version, emit)
    # Finalize the version: pins clue/parties/reps snapshots + sets topic complete (⇄ finalizeVersion).
    await asyncio.to_thread(
        state_manager.finalize_version, topic_id, version,
        forum_session_id=out.get("forum_session_id"), verdict_id=out.get("verdict_id"))
    emit({"type": "stage_complete", "stage": "expert_council"})
    return {"version": version, "scenarios_ranked": out["scenarios_ranked"]}


async def score_into_version(topic_id: str, title: str, description: str, version: int,
                             emit) -> dict:
    """Score the current evidence into a verdict for an ALREADY-ALLOCATED version (save_verdict +
    verdict_content SSE) WITHOUT finalizing the version. run_scoring wraps this with allocate +
    finalize; the delta pipeline calls it directly (it finalizes with delta provenance itself).
    Returns {scenarios_ranked, final_assessment, confidence_note, verdict_id, forum_session_id}."""
    emit({"type": "progress", "stage": "expert_council", "pct": 0.0, "msg": "Scoring scenarios…"})

    parties = await reads.list_parties(topic_id)
    clues = await reads.list_clues(topic_id)
    density = independent_density(
        [{"credibility": c.get("credibility") or 50, "relevance": c.get("relevance") or 50,
          "bias_flags": c.get("bias_flags") or [], "sources": c.get("sources") or []} for c in clues]
    )
    topic_str = (f"{title}\n{description}".strip()
                 + await steering.steering_for(topic_id, "evidence"))
    parties_str = _parties_str(parties)
    evidence_str = _evidence_str(clues, density)

    # If a forum debate ran, ground scenario synthesis in it (summary + endorsed outcomes).
    forum = await reads.get_forum_session(topic_id)
    forum_note = ""
    if forum and (forum.get("debate_summary") or forum.get("scenarios")):
        ends = "\n".join(
            f"- {s['title']} (backed by: {', '.join(s.get('supported_by', [])) or '—'})"
            for s in forum.get("scenarios", [])[:8]
        )
        forum_note = (
            f"\n\n=== FORUM DEBATE ===\nSummary: {(forum.get('debate_summary') or '')[:1500]}\n"
            f"Outcomes endorsed by the parties:\n{ends or '(none)'}\n"
            "Use the debate to inform the candidate scenarios and which parties back each."
        )
        evidence_str += forum_note
    emit({"type": "think", "icon": "⚖", "label": "evidence assembled",
          "detail": f"{len(clues)} clues · {density['source_clusters']} clusters · {len(parties)} parties"
                    f"{' · forum debate' if forum_note else ''}"})

    model = dspy_lm.model_for(topic_id, "expert_council")

    def _work() -> dict:
        with dspy_lm.lm_context(model):
            scorer = ScenarioScorer()
            pred = scorer(topic=topic_str, parties_str=parties_str, evidence_str=evidence_str)
            return {
                "scenarios_ranked": [s.model_dump() for s in pred.scenarios_ranked],
                "final_assessment": pred.final_assessment,
                "confidence_note": pred.confidence_note,
            }

    emit({"type": "progress", "stage": "expert_council", "pct": 0.5, "msg": "Synthesizing & scoring scenarios…"})
    out = await asyncio.to_thread(_work)

    ranked = out["scenarios_ranked"]
    experts = [{
        "id": "scenario-scorer", "name": "Scenario Scorer",
        "domain": "Geopolitical forecasting & calibration",
        "persona_prompt": "Scores candidate scenarios from grounded evidence with reference-class "
                          "base rates and objective resolution criteria.",
        "auto_generated": True,
    }]
    verdict_id = writers.save_verdict(
        topic_id, version, experts, ranked,
        out["final_assessment"], out["confidence_note"],
        evidence_map=[], debate_summary=(forum or {}).get("debate_summary"),
    )
    top = ranked[0] if ranked else None
    emit({
        "type": "verdict_content",
        "scenarios": [{"title": s["title"], "probability": s["probability"]} for s in ranked],
        "headline": (f"{top['title']} — {round(top['probability'] * 100)}%" if top else "No scenarios"),
        "final_assessment": out["final_assessment"],
        "confidence_note": out["confidence_note"],
    })
    emit({"type": "progress", "stage": "expert_council", "pct": 1.0,
          "msg": f"Verdict ready — {len(ranked)} scenarios ranked"})
    return {"scenarios_ranked": ranked, "final_assessment": out["final_assessment"],
            "confidence_note": out["confidence_note"], "verdict_id": verdict_id,
            "forum_session_id": (forum or {}).get("session_id")}

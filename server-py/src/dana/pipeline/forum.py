"""Forum stage (⇄ TS gatedPipeline.runForumStage + ForumOrchestrator).

A moderator frames the debate, then representatives speak in three phases — opening →
rebuttal → closing — each grounded in the clues and in character for their party. Turns are
persisted to forum_rounds/forum_turns and streamed as `forum_turn` SSE events; the distinct
endorsed outcomes become forum_scenarios; a synthesis step writes the debate summary.

Status flow: review_forum_prep -> forum -> review_forum. DSPy runs in a worker thread.
Bounded by env: DANA_FORUM_MAX_PARTIES (default 6), DANA_FORUM_PHASES (default opening,rebuttal,closing).
"""
import asyncio
import os

from ..agents.forum import Moderator, Representative, Synthesizer
from ..db import reads, writers
from ..events.bus import bus
from ..llm import dspy_lm, steering
from .scoring import forum_evidence_str

PHASE_ORDER = ["opening_statements", "rebuttal", "closing"]


def _max_parties() -> int:
    try:
        return max(2, int(os.getenv("DANA_FORUM_MAX_PARTIES", "6")))
    except ValueError:
        return 6


def _phases() -> list[str]:
    raw = os.getenv("DANA_FORUM_PHASES", "")
    if not raw:
        return PHASE_ORDER
    want = [p.strip() for p in raw.split(",") if p.strip() in PHASE_ORDER]
    return want or PHASE_ORDER


def _wc(s: str) -> int:
    return len((s or "").split())


async def run_forum(topic_id: str, title: str, description: str) -> dict:
    def emit(ev: dict) -> None:
        bus.emit(topic_id, ev)

    version = 1
    writers.set_topic_status(topic_id, "forum")
    emit({"type": "progress", "stage": "forum", "pct": 0.0, "msg": "Starting forum…"})

    parties = await reads.list_parties(topic_id)
    clues = await reads.list_clues(topic_id)
    reps = await reads.list_representatives(topic_id)
    rep_by_party = {r["party_id"]: r for r in reps}
    # Speak in descending influence; cap the roster so the debate stays bounded.
    parties = sorted(parties, key=lambda p: rep_by_party.get(p["id"], {}).get("speaking_weight", p.get("weight") or 0),
                     reverse=True)[: _max_parties()]
    topic_str = f"{title}\n{description}".strip()
    parties_str = "\n".join(f"- {p['name']} ({p.get('type', '?')}): {p.get('agenda', '')}" for p in parties)
    evidence_str = forum_evidence_str(clues)
    phases = _phases()

    session_id = writers.create_forum_session(topic_id, version, "full")

    def _frame() -> dict:
        with dspy_lm.lm_context():
            out = Moderator()(topic=topic_str, parties=parties_str, evidence=evidence_str)
            return {"central_question": out.central_question, "points_of_contention": list(out.points_of_contention)}

    framing = await asyncio.to_thread(_frame)
    directive_base = (framing["central_question"] + "\nContention: "
                      + "; ".join(framing["points_of_contention"][:4])
                      + await steering.steering_for(topic_id, "debate"))
    emit({"type": "think", "icon": "⚖", "label": "Moderator framed the forum",
          "detail": framing["central_question"][:120]})

    all_turns: list[dict] = []
    total_steps = len(phases) * max(1, len(parties))
    step = 0

    for phase_idx, phase in enumerate(phases, 1):
        round_id = writers.add_forum_round(session_id, topic_id, phase_idx, "debate")
        directive = directive_base
        if phase == "rebuttal":
            directive = "Rebut the opposing parties by name; defend your position. " + directive_base
        elif phase == "closing":
            directive = "Closing: endorse the single outcome scenario that best serves you. " + directive_base

        for p in parties:
            rep = rep_by_party.get(p["id"], {})
            persona = (rep.get("persona_prompt") or f"You represent {p['name']}.") + f"\nAgenda: {p.get('agenda', '')}"
            recent = "\n\n".join(
                f"{t['party_name']}: {t['statement'][:400]}" for t in all_turns[-4:]
            ) or "(you speak first)"

            def _speak(_persona=persona, _phase=phase, _directive=directive, _recent=recent) -> dict:
                with dspy_lm.lm_context():
                    o = Representative()(
                        topic=topic_str, persona=_persona, phase=_phase, directive=_directive,
                        recent_turns=_recent, evidence=evidence_str,
                    )
                    return {
                        "statement": o.statement, "position": o.position,
                        "evidence": [e.model_dump() for e in o.evidence_cited],
                        "challenges": [c.model_dump() for c in o.challenges],
                        "concessions": list(o.concessions),
                        "scenario_endorsement": o.scenario_endorsement,
                        "clues_cited": list(o.clues_cited),
                    }

            try:
                spoken = await asyncio.to_thread(_speak)
            except Exception as e:  # noqa: BLE001
                emit({"type": "think", "icon": "⚠", "label": f"{p['name']} turn failed", "detail": str(e)[:80]})
                continue

            turn = {
                "id": f"turn-{phase_idx}-{writers.slugify(p['id'], 16)}-{step}",
                "party_id": p["id"], "representative_id": rep.get("id", f"rep-{p['id']}"),
                "party_name": p["name"], "persona_title": rep.get("persona_title"),
                "position": spoken["position"], "evidence": spoken["evidence"],
                "challenges": spoken["challenges"], "concessions": spoken["concessions"],
                "statement": spoken["statement"], "scenario_endorsement": spoken["scenario_endorsement"],
                "clues_cited": spoken["clues_cited"], "word_count": _wc(spoken["statement"]),
                "round": phase_idx, "type": phase,
                "moderator_directive": directive if phase != "opening_statements" else None,
                "moderator_reason": None,
            }
            writers.add_forum_turn(topic_id, round_id, turn)
            all_turns.append(turn)
            emit({"type": "forum_turn", "turn": {**turn, "timestamp": ""}})
            step += 1
            emit({"type": "progress", "stage": "forum", "pct": min(0.95, step / total_steps),
                  "msg": f"{phase}: {p['name']} ({len(all_turns)} turns)"})

    # Aggregate distinct endorsed outcomes into forum_scenarios.
    scenarios = _aggregate_scenarios(session_id, all_turns)
    writers.save_forum_scenarios(session_id, topic_id, scenarios)

    transcript = "\n\n".join(f"[{t['type']}] {t['party_name']}: {t['statement']}" for t in all_turns)

    def _synth() -> str:
        with dspy_lm.lm_context():
            return Synthesizer()(topic=topic_str, transcript=transcript[:12000]).debate_summary

    debate_summary = await asyncio.to_thread(_synth) if all_turns else ""
    writers.save_forum_scenario_summary(session_id, topic_id, _scenario_summary(scenarios, all_turns))
    writers.complete_forum_session(session_id, topic_id, debate_summary)
    writers.set_topic_status(topic_id, "review_forum")
    emit({"type": "progress", "stage": "forum", "pct": 1.0,
          "msg": f"Forum complete — {len(all_turns)} turns, {len(scenarios)} scenarios"})
    emit({"type": "stage_complete", "stage": "forum", "session_id": session_id})
    return {"session_id": session_id, "turns": len(all_turns), "scenarios": scenarios,
            "debate_summary": debate_summary}


def _aggregate_scenarios(session_id: str, turns: list[dict]) -> list[dict]:
    """Dedupe endorsed outcomes by normalized prefix; track who backs each + clues cited."""
    by_key: dict[str, dict] = {}
    for t in turns:
        end = (t.get("scenario_endorsement") or "").strip()
        if not end:
            continue
        key = end.lower()[:80]
        s = by_key.setdefault(key, {
            "id": f"fscn-{len(by_key) + 1}", "title": end[:120], "description": end,
            "proposed_by": t["party_name"], "supported_by": [], "contested_by": [],
            "clues_cited": [], "benefiting_parties": [], "required_conditions": [],
            "falsification_conditions": [],
        })
        if t["party_name"] not in s["supported_by"]:
            s["supported_by"].append(t["party_name"])
            s["benefiting_parties"].append(t["party_name"])
        for cid in t.get("clues_cited", []):
            if cid not in s["clues_cited"]:
                s["clues_cited"].append(cid)
    return sorted(by_key.values(), key=lambda s: len(s["supported_by"]), reverse=True)


def _scenario_summary(scenarios: list[dict], turns: list[dict]) -> dict:
    challenged: set[str] = set()
    cited: set[str] = set()
    for t in turns:
        for c in t.get("challenges", []):
            if c.get("clue_id"):
                challenged.add(c["clue_id"])
        for cid in t.get("clues_cited", []):
            cited.add(cid)
    return {
        "scenarios": [{"id": s["id"], "title": s["title"], "key_clues": s["clues_cited"]} for s in scenarios],
        "contested_clues": [{"clue_id": c, "cited_by": [], "conflict": "challenged in debate"} for c in sorted(challenged)],
        "uncontested_clues": sorted(cited - challenged),
    }

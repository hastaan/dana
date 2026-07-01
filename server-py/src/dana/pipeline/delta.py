"""Delta pipeline (⇄ TS pipeline/deltaPipeline.ts).

A true clue-version delta re-analysis, the faithful port of the TS `runDeltaPipeline` that the
interim `/pipeline/update` fallback stood in for:

1. computeDelta — diff current clues vs the latest COMPLETE version's snapshot. No change → error.
2. Fork a new version from the latest complete one (parent snapshots inherited).
3. Delta forum — each representative makes ONE position-update turn over the new/updated clues
   (DeltaRepresentative); persisted as a `type="delta"` forum session + streamed as forum_turn.
4. Scenario impact — synthesize how each prior scenario is affected (DeltaScenarioImpact).
5. Re-score the updated evidence into a fresh verdict, then record the version COMPLETE with
   delta_from + delta_summary (so the staleness banner's "View Changes" diff resolves).

DSPy work runs in worker threads (asyncio.to_thread under lm_context) so the loop/SSE never block.
"""
import asyncio
import json

import dspy

from ..agents.delta_intel import DeltaRepresentative, DeltaScenarioImpact
from ..db import reads, writers
from ..events.bus import bus
from ..llm import dspy_lm
from . import scoring, state_manager


def _wc(s: str) -> int:
    return len((s or "").split())


async def run_delta(topic_id: str, title: str, description: str, run_id: str) -> dict:
    """Run the true delta pipeline. Raises ValueError('No changes detected') when computeDelta
    finds nothing new (the route maps that to a 400)."""
    def emit(ev: dict) -> None:
        bus.emit(topic_id, ev)

    emit({"type": "progress", "stage": "delta", "pct": 0.0, "msg": "Computing clue delta…"})
    latest = await asyncio.to_thread(writers.get_latest_complete_state, topic_id)
    if not latest:
        raise ValueError("No prior complete version to delta from")
    delta = await asyncio.to_thread(state_manager.compute_delta, topic_id)
    if not delta:
        raise ValueError("No changes detected")

    change_narrative = delta["key_change"]
    emit({"type": "think", "icon": "🔬", "label": "Delta detected",
          "detail": f"{len(delta['new_clues'])} new · {len(delta['updated_clues'])} updated"})

    model = dspy_lm.model_for(topic_id, "delta_updates")

    # Fork a new in-progress version from the latest complete one (at the forum stage — the
    # delta builds its own forum but reuses prior parties/reps/clues<=fork).
    version = await asyncio.to_thread(
        state_manager.allocate_version, topic_id, fork_from=latest["version"],
        fork_stage="forum", trigger="user_manual",
        label=f"Delta update: {change_narrative[:80]}")

    prior_session_id = latest["forum_session_id"] or "forum-session-v1"
    new_session_id = f"forum-session-v{version}"

    # ── Gather context: reps, prior turns, the changed clues ──
    reps = await reads.list_representatives(topic_id)
    parties = {p["id"]: p for p in await reads.list_parties(topic_id)}
    prior = await reads.get_forum_session(topic_id, session_id=prior_session_id)
    prior_turns_by_party: dict[str, list[str]] = {}
    if prior:
        for rnd in prior.get("rounds", []):
            for t in rnd.get("turns", []):
                prior_turns_by_party.setdefault(t.get("party_id") or "", []).append(
                    f"[R{t.get('round', 1)}]: {(t.get('statement') or '')[:400]}")

    all_clues = {c["id"]: c for c in await reads.list_clues(topic_id)}
    changed_detail_lines = []
    for cid in delta["new_clues"] + delta["updated_clues"]:
        c = all_clues.get(cid)
        if c:
            changed_detail_lines.append(f"[{cid}] {c.get('title', '')}: {(c.get('summary') or '')[:300]}")
    changed_detail = "\n".join(changed_detail_lines) or "(no clue detail available)"

    writers.set_topic_status(topic_id, "forum")
    emit({"type": "progress", "stage": "forum", "pct": 0.1, "msg": "Running delta forum…"})

    session_id = await asyncio.to_thread(writers.create_forum_session, topic_id, version, "delta")
    round_id = await asyncio.to_thread(writers.add_forum_round, session_id, topic_id, 1, "position_updates")

    # ── Per-rep delta turns ──
    delta_turns: list[dict] = []
    for i, rep in enumerate(reps):
        pid = rep["party_id"]
        party = parties.get(pid, {})
        persona = rep.get("persona_prompt") or f"You represent {party.get('name', pid)}."
        prior_statements = "\n\n".join(prior_turns_by_party.get(pid, [])) or "No prior statements found."

        def _work(_persona=persona, _party=party, _prior=prior_statements):
            with dspy_lm.lm_context(model):
                return dspy.ChainOfThought(DeltaRepresentative)(
                    persona=_persona, party_name=_party.get("name", pid),
                    agenda=_party.get("agenda", ""), change_narrative=change_narrative,
                    new_clues=changed_detail, prior_statements=_prior,
                ).update

        try:
            upd = await asyncio.to_thread(_work)
        except Exception as e:  # noqa: BLE001 — one rep failing must not abort the delta
            emit({"type": "think", "icon": "⚠", "label": f"{party.get('name', pid)} delta failed",
                  "detail": str(e)[:80]})
            continue

        statement = (f"PRIOR: {upd.prior_position_summary}\n\nUPDATED: {upd.updated_position}\n\n"
                     f"DELTA: {upd.position_delta}")
        turn = {
            "id": f"delta-turn-{writers.slugify(pid, 16)}", "party_id": pid,
            "representative_id": rep.get("id", f"rep-{pid}"), "party_name": party.get("name", pid),
            "persona_title": rep.get("persona_title"), "position": upd.position_delta,
            "evidence": [], "challenges": [], "concessions": [], "statement": statement,
            "scenario_endorsement": None, "clues_cited": list(upd.clues_cited),
            "word_count": _wc(upd.updated_position), "round": 1, "type": "position_update",
            "moderator_directive": None, "moderator_reason": None,
        }
        await asyncio.to_thread(writers.add_forum_turn, topic_id, round_id, turn)
        delta_turns.append({**turn, "position_delta": upd.position_delta,
                            "updated_position": upd.updated_position})
        emit({"type": "forum_turn", "turn": {**turn, "timestamp": ""}})
        emit({"type": "progress", "stage": "forum", "pct": min(0.7, 0.1 + 0.6 * (i + 1) / max(1, len(reps))),
              "msg": f"Delta: {party.get('name', pid)} ({upd.position_delta})"})

    # ── Scenario impact synthesis (over the prior session's scenarios) ──
    prior_scenarios = (prior or {}).get("scenarios", []) if prior else []
    emit({"type": "progress", "stage": "forum", "pct": 0.8, "msg": "Synthesizing scenario updates…"})
    scenario_impacts: list[dict] = []
    if prior_scenarios and delta_turns:
        updates_str = "\n\n".join(
            f"{t['party_name']} [{t['position_delta']}]: {t['updated_position'][:300]}" for t in delta_turns)
        scenarios_str = "\n".join(f"- {s['id']}: {s.get('title', '')}" for s in prior_scenarios)

        def _impact():
            with dspy_lm.lm_context(model):
                return dspy.ChainOfThought(DeltaScenarioImpact)(
                    change_narrative=change_narrative, position_updates=updates_str,
                    scenarios=scenarios_str).impacts or []

        try:
            scenario_impacts = [s.model_dump() for s in await asyncio.to_thread(_impact)]
        except Exception:  # noqa: BLE001
            scenario_impacts = []

    # Persist the delta forum session: carry prior scenarios forward, annotated with impact.
    impact_by_id = {s["scenario_id"]: s for s in scenario_impacts}
    carried = []
    for s in prior_scenarios:
        imp = impact_by_id.get(s["id"])
        carried.append({**s, "delta_update_type": imp["update_type"] if imp else "unchanged",
                        "delta_reason": imp["reason"] if imp else ""})
    if carried:
        await asyncio.to_thread(writers.save_forum_scenarios, session_id, topic_id, carried)
    summary = {
        "scenarios": [{"id": s["id"], "title": s.get("title", ""),
                       "key_clues": s.get("clues_cited", [])} for s in carried],
        "contested_clues": [], "uncontested_clues": [],
        "delta": {"change": change_narrative, "impacts": scenario_impacts},
    }
    await asyncio.to_thread(writers.save_forum_scenario_summary, session_id, topic_id, summary)
    debate_summary = (f"Delta update — {change_narrative}. "
                      + "; ".join(f"{t['party_name']}: {t['position_delta']}" for t in delta_turns))
    await asyncio.to_thread(writers.complete_forum_session, session_id, topic_id, debate_summary)
    await asyncio.to_thread(state_manager.set_version_session_id, topic_id, version, session_id)
    await asyncio.to_thread(state_manager.mark_stage_complete, topic_id, version, "forum")
    emit({"type": "stage_complete", "stage": "forum", "session_id": session_id})

    # ── Re-score the updated evidence into a fresh verdict for THIS version ──
    writers.set_topic_status(topic_id, "expert_council")
    emit({"type": "progress", "stage": "expert_council", "pct": 0.0, "msg": "Scoring updated scenarios…"})
    score_out = await scoring.score_into_version(topic_id, title, description, version, emit)

    # ── Record the version COMPLETE with delta provenance ──
    await asyncio.to_thread(
        state_manager.finalize_version, topic_id, version,
        forum_session_id=new_session_id, verdict_id=score_out.get("verdict_id") or f"verdict-v{version}")
    # Stamp delta_from + delta_summary onto the version (finalize_version doesn't set these).
    await asyncio.to_thread(_stamp_delta, topic_id, version, latest["version"], delta)

    emit({"type": "stage_complete", "stage": "verdict"})
    emit({"type": "progress", "stage": "expert_council", "pct": 1.0,
          "msg": f"Delta update complete — v{version}"})
    return {"run_id": run_id, "status": "complete", "version": version,
            "scenarios_ranked": score_out.get("scenarios_ranked", [])}


def _stamp_delta(topic_id: str, version: int, delta_from: int, delta_summary: dict) -> None:
    """Write delta_from + delta_summary onto the finalized version (the staleness banner reads
    delta_summary; finalize_version doesn't set these)."""
    from ..db.sync_db import connect
    with connect() as c:
        c.execute("UPDATE states SET delta_from=?, delta_summary=?, parent_version=COALESCE(parent_version, ?) "
                  "WHERE topic_id=? AND version=?",
                  (delta_from, json.dumps(delta_summary), delta_from, topic_id, version))

"""Forum stage (⇄ TS gatedPipeline.runForumStage + ForumOrchestrator + ForumSupervisor).

A moderator frames the debate, then a MODERATED debate loop runs: a supervisor picks the next
speaker by relevance/balance, injects focus, and detects convergence/repetition to break the loop
early (not a fixed round-robin). Each representative speaks in character, grounded in the clues.
Turns are persisted to forum_rounds/forum_turns and streamed as `forum_turn` SSE events; the
distinct endorsed outcomes become forum_scenarios; a synthesis step writes the debate summary.

Status flow: review_forum_prep -> forum -> review_forum. DSPy runs in a worker thread. Bounded
by env: DANA_FORUM_MAX_PARTIES (default 6 — roster cap) and DANA_FORUM_MAX_TURNS (default 50 —
the moderated loop's hard ceiling; pure-Python guardrails guarantee termination/breadth even if
the model misbehaves). DANA_FORUM_PHASES is no longer used (phases are derived from the loop).
"""
import asyncio
import os

from ..agents.forum import Moderator, Representative, Supervisor, Synthesizer
from ..db import reads, writers
from ..events.bus import bus
from ..llm import dspy_lm, steering
from . import state_manager
from .scoring import forum_evidence_str

PHASE_ORDER = ["opening_statements", "rebuttal", "closing"]


def _max_parties() -> int:
    try:
        return max(2, int(os.getenv("DANA_FORUM_MAX_PARTIES", "6")))
    except ValueError:
        return 6


def _max_turns() -> int:
    try:
        return max(4, int(os.getenv("DANA_FORUM_MAX_TURNS", "50")))
    except ValueError:
        return 50


def _wc(s: str) -> int:
    return len((s or "").split())


def _detect_exchange_loop(recent: list[str]) -> tuple[bool, list[str]]:
    """⇄ TS detectExchangeLoop: the last 4 speakers spanning <=2 distinct parties => looping."""
    if len(recent) < 4:
        return False, []
    last4 = recent[-4:]
    uniq = list(dict.fromkeys(last4))
    return (len(uniq) <= 2), uniq


def _deficit_pick(parties: list[dict], weight_of: dict, dist: dict, total_turns: int) -> dict | None:
    """⇄ TS deficitFallback: pick the party with the largest deficit (expected share minus actual
    turn share). expected share = weight/100, actual = count/max(total_turns,1)."""
    if not parties:
        return None
    total = max(total_turns, 1)
    best, best_def = parties[0], float("-inf")
    for p in parties:
        expected = (weight_of.get(p["id"], 0) or 0) / 100.0
        deficit = expected - (dist.get(p["id"], 0) / total)
        if deficit > best_def:
            best_def, best = deficit, p
    return best


def _silent_parties(parties: list[dict], recent: list[str], dist: dict, turn_count: int) -> list[str]:
    """⇄ TS computeSilentParties: silent if a party last spoke 8+ turns ago, or has 0 turns once
    the debate is past its opening (turn_count >= 3)."""
    out: list[str] = []
    for p in parties:
        pid = p["id"]
        count = dist.get(pid, 0)
        last = (len(recent) - 1 - recent[::-1].index(pid)) if pid in recent else -1
        turns_since = turn_count if last == -1 else (len(recent) - 1 - last) + max(0, turn_count - len(recent))
        if turns_since >= 8 and count > 0:
            out.append(pid)
        elif count == 0 and turn_count >= 3:
            out.append(pid)
    return out


def _budget_warning(turn_count: int, soft_ceiling: int, max_turns: int) -> str:
    """⇄ TS computeBudgetWarning: FINAL when <=3 hard turns remain, OVER once past soft_ceiling,
    WRAP-UP when <=3 soft turns remain."""
    hard_remaining = max_turns - turn_count
    soft_remaining = soft_ceiling - turn_count
    if hard_remaining <= 3:
        return f"FINAL TURNS: only {hard_remaining} turns before the hard limit — deliver a closing synthesis."
    if turn_count >= soft_ceiling:
        return (f"OVER EXPECTED LENGTH: past the expected {soft_ceiling}-turn length — close unless a "
                "critical unresolved argument remains.")
    if 0 < soft_remaining <= 3:
        return (f"WRAP-UP PHASE: {soft_remaining} turns until the expected end at turn {soft_ceiling} — "
                "begin directing parties toward final positions.")
    return ""


def _phase_for(turn_count: int, n_parties: int, warning: str) -> str:
    """Derive a phase label for persistence/SSE parity: opening for the first n_parties turns,
    closing once a budget warning fires, else rebuttal."""
    if turn_count < n_parties:
        return "opening_statements"
    if warning:
        return "closing"
    return "rebuttal"


async def run_forum(topic_id: str, title: str, description: str) -> dict:
    def emit(ev: dict) -> None:
        bus.emit(topic_id, ev)

    writers.set_topic_status(topic_id, "forum")
    version = await asyncio.to_thread(
        state_manager.get_or_allocate_version, topic_id, fork_stage="forum")
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

    session_id = writers.create_forum_session(topic_id, version, "full")
    model = dspy_lm.model_for(topic_id, "forum_reasoning")

    def _frame() -> dict:
        with dspy_lm.lm_context(model):
            out = Moderator()(topic=topic_str, parties=parties_str, evidence=evidence_str)
            return {"central_question": out.central_question, "points_of_contention": list(out.points_of_contention)}

    framing = await asyncio.to_thread(_frame)
    directive_base = (framing["central_question"] + "\nContention: "
                      + "; ".join(framing["points_of_contention"][:4])
                      + await steering.steering_for(topic_id, "debate"))
    emit({"type": "think", "icon": "⚖", "label": "Moderator framed the forum",
          "detail": framing["central_question"][:120]})

    # ── Moderated debate loop (⇄ ForumSupervisor) ────────────────────────────────────
    weight_of: dict[str, float] = {
        p["id"]: (rep_by_party.get(p["id"], {}).get("speaking_weight") or p.get("weight") or 10.0)
        for p in parties
    }
    total_weight = sum(weight_of.values()) or 1.0
    party_by_id = {p["id"]: p for p in parties}
    max_turns = _max_turns()
    min_turns = max(8, len(parties) * 2)
    soft_ceiling = round(min_turns * 1.3)
    n_parties = len(parties)

    round_id = writers.add_forum_round(session_id, topic_id, 1, "debate")
    all_turns: list[dict] = []
    dist: dict[str, int] = {p["id"]: 0 for p in parties}
    recent: list[str] = []          # speaker party_ids, capped to last 6
    seen_scenarios: set[str] = set()  # distinct endorsement keys observed (closure gate)
    sup = Supervisor()
    fails = 0                        # speak failures don't grow all_turns → cap them so a
    fail_cap = max(6, 2 * n_parties)  # persistent _speak error (proxy down) can't spin forever

    while len(all_turns) < max_turns:
        turn_count = len(all_turns)
        warning = _budget_warning(turn_count, soft_ceiling, max_turns)

        # ── Pre-LLM guard: break two-party exchange loops without an LLM call (⇄ TS) ──
        decision = None
        looping, loop_pair = _detect_exchange_loop(recent)
        if looping:
            others = [p for p in parties if p["id"] not in loop_pair]
            pick = _deficit_pick(others or parties, weight_of, dist, turn_count)
            emit({"type": "think", "icon": "⚖", "label": "Breaking exchange loop",
                  "detail": f"{' vs '.join(loop_pair)} → {pick['id'] if pick else '?'}"})
            decision = {
                "next_speaker": pick["id"] if pick else "",
                "reason": f"Breaking {' vs '.join(loop_pair)} exchange loop — other parties need the floor",
                "directive": "We've heard extensive exchange between the previous speakers. "
                             "Let's hear a fresh perspective.",
                "should_close": False,
            }

        if decision is None:
            parties_list = "\n".join(
                f"- {p['id']} (priority={round(100 * weight_of[p['id']] / total_weight)}%, "
                f"turns={dist.get(p['id'], 0)}/{max(1, round((weight_of[p['id']] / total_weight) * soft_ceiling))})"
                for p in parties
            )
            turn_distribution = ", ".join(f"{pid}: {n} turns" for pid, n in dist.items() if n) or "none yet"
            recent_speakers = " -> ".join(recent[-4:]) or "None yet"
            silent = _silent_parties(parties, recent, dist, turn_count)
            silent_str = (f"SILENT PARTIES (no recent floor time): {', '.join(silent)}" if silent else "")
            scenarios_summary = "\n".join(f"• {s}" for s in sorted(seen_scenarios)) or "No scenarios yet"
            last_turn = (f"[{all_turns[-1]['party_name']}]: {all_turns[-1]['statement']}"[:500]
                         if all_turns else "This is the first turn of the debate.")
            steer = await steering.steering_for(topic_id, "debate")

            def _moderate(_pl=parties_list, _td=turn_distribution, _rs=recent_speakers,
                          _sp=silent_str, _bw=warning, _ss=scenarios_summary, _lt=last_turn,
                          _tn=turn_count + 1, _steer=steer) -> dict:
                with dspy_lm.lm_context(model):
                    d = sup(
                        topic=topic_str + _steer, parties_list=_pl, turn_distribution=_td,
                        recent_speakers=_rs, silent_parties=_sp, budget_warning=_bw,
                        scenarios_summary=_ss, last_turn=_lt, turn_number=_tn,
                        soft_ceiling=soft_ceiling, hard_limit=max_turns, min_turns=min_turns,
                    )
                    return {"next_speaker": d.next_speaker, "reason": d.reason,
                            "directive": d.directive, "should_close": d.should_close}

            try:
                decision = await asyncio.to_thread(_moderate)
            except Exception as e:  # noqa: BLE001
                pick = _deficit_pick(parties, weight_of, dist, turn_count)
                emit({"type": "think", "icon": "⚠", "label": "Moderator fell back",
                      "detail": f"{str(e)[:60]} → {pick['id'] if pick else '?'}"})
                decision = {"next_speaker": pick["id"] if pick else "", "reason":
                            "Fallback: deficit-based selection after moderate error",
                            "directive": "", "should_close": False}

        # ── Closure gate (⇄ TS): honor should_close only past min_turns AND >=2 scenarios ──
        if decision.get("should_close") and turn_count >= min_turns and len(seen_scenarios) >= 2:
            emit({"type": "think", "icon": "🏁", "label": "Moderator closed the debate",
                  "detail": (decision.get("reason") or "")[:120]})
            break

        # Resolve the next speaker to a real party (deficit fallback if unknown/closing-but-blocked).
        next_id = decision.get("next_speaker") or ""
        p = party_by_id.get(next_id)
        if p is None:
            p = _deficit_pick(parties, weight_of, dist, turn_count)
            if p is None:
                break

        phase = _phase_for(turn_count, n_parties, warning)
        reason = decision.get("reason") or ""
        directive_extra = decision.get("directive") or ""
        if phase == "rebuttal" and not directive_extra:
            directive_extra = "Rebut the opposing parties by name; defend your position."
        elif phase == "closing" and not directive_extra:
            directive_extra = "Closing: endorse the single outcome scenario that best serves you."
        full_directive = (directive_extra + " " + directive_base).strip()

        rep = rep_by_party.get(p["id"], {})
        persona = (rep.get("persona_prompt") or f"You represent {p['name']}.") + f"\nAgenda: {p.get('agenda', '')}"
        recent_text = "\n\n".join(
            f"{t['party_name']}: {t['statement'][:400]}" for t in all_turns[-4:]
        ) or "(you speak first)"

        def _speak(_persona=persona, _phase=phase, _directive=full_directive, _recent=recent_text) -> dict:
            with dspy_lm.lm_context(model):
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
            # Bump bookkeeping so the same broken party isn't re-picked forever.
            dist[p["id"]] = dist.get(p["id"], 0) + 1
            recent.append(p["id"])
            recent[:] = recent[-6:]
            # Failures don't append to all_turns, so the while-guard can't end the loop on its own;
            # cap total failures so a persistent _speak error (e.g. proxy down) terminates instead of spinning.
            fails += 1
            if fails >= fail_cap:
                emit({"type": "think", "icon": "🛑", "label": "Forum aborted",
                      "detail": f"{fails} consecutive turn failures — ending debate"})
                break
            continue

        turn = {
            "id": f"turn-1-{writers.slugify(p['id'], 16)}-{turn_count}",
            "party_id": p["id"], "representative_id": rep.get("id", f"rep-{p['id']}"),
            "party_name": p["name"], "persona_title": rep.get("persona_title"),
            "position": spoken["position"], "evidence": spoken["evidence"],
            "challenges": spoken["challenges"], "concessions": spoken["concessions"],
            "statement": spoken["statement"], "scenario_endorsement": spoken["scenario_endorsement"],
            "clues_cited": spoken["clues_cited"], "word_count": _wc(spoken["statement"]),
            "round": 1, "type": phase,
            "moderator_directive": full_directive or None,
            "moderator_reason": reason or None,
        }
        writers.add_forum_turn(topic_id, round_id, turn)
        all_turns.append(turn)
        dist[p["id"]] = dist.get(p["id"], 0) + 1
        recent.append(p["id"])
        recent[:] = recent[-6:]
        end = (spoken.get("scenario_endorsement") or "").strip()
        if end:
            seen_scenarios.add(end.lower()[:80])
        emit({"type": "forum_turn", "turn": {**turn, "timestamp": ""}})
        emit({"type": "progress", "stage": "forum", "pct": min(0.95, len(all_turns) / max_turns),
              "msg": f"{phase}: {p['name']} ({len(all_turns)} turns)"})

    # Aggregate distinct endorsed outcomes into forum_scenarios.
    scenarios = _aggregate_scenarios(session_id, all_turns)
    writers.save_forum_scenarios(session_id, topic_id, scenarios)

    transcript = "\n\n".join(f"[{t['type']}] {t['party_name']}: {t['statement']}" for t in all_turns)

    def _synth() -> str:
        with dspy_lm.lm_context(model):
            return Synthesizer()(topic=topic_str, transcript=transcript[:12000]).debate_summary

    debate_summary = await asyncio.to_thread(_synth) if all_turns else ""
    writers.save_forum_scenario_summary(session_id, topic_id, _scenario_summary(scenarios, all_turns))
    writers.complete_forum_session(session_id, topic_id, debate_summary)
    await asyncio.to_thread(state_manager.set_version_session_id, topic_id, version, session_id)
    await asyncio.to_thread(state_manager.mark_stage_complete, topic_id, version, "forum")
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

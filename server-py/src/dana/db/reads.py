"""Async read helpers for parties, clues, and verdicts (shaped for the API ⇄ TS)."""
import json
import sqlite3
import time
from datetime import datetime

from sqlalchemy import text

from . import writers
from .engine import get_engine
from .sync_db import connect


# ── Synthesis cache read (sync — called from the engine worker thread; mirrors
#    corpus_find_search's age check; re-uses research_pages via a synthetic url) ──
def get_cached_synthesis(topic_id: str, level: str, query: str,
                         max_age_hours: float = 24.0) -> dict | None:
    """Return a previously cached synthesized output (deep_lookup answer / deep_search
    briefing) or None when absent or older than the TTL. Keyed by tier+query (global, not
    topic-scoped) so the HTTP facade's ad-hoc lookups share cache with pipeline calls."""
    try:
        with connect() as c:
            row = c.execute(
                "SELECT content, fetched_at FROM synthesis_cache WHERE key=?",
                (writers.synthesis_url(level, query),),
            ).fetchone()
    except sqlite3.Error:
        return None  # table not created yet (no writes) → cache miss
    if not row:
        return None
    try:
        age = time.time() - datetime.fromisoformat(row["fetched_at"]).timestamp()
        if age > max_age_hours * 3600:
            return None
        return json.loads(row["content"])
    except (ValueError, KeyError, TypeError, json.JSONDecodeError):
        return None


# ── Prompt overrides (Lane A — sync; read at DSPy-configure time in the worker thread,
#    and by the api/prompts.py router. Mirror corpus_find_search's connect() pattern) ──
def get_prompt_instructions(name: str) -> str | None:
    """Return the persisted instruction-text override for a prompt, or None when unset
    (→ caller falls back to the signature's own __doc__). A missing table → cache miss."""
    try:
        with connect() as c:
            row = c.execute(
                "SELECT instructions FROM prompt_overrides WHERE name=?", (name,)
            ).fetchone()
    except sqlite3.Error:
        return None
    return row["instructions"] if row else None


def get_prompt_config(name: str) -> dict:
    """Return the {model, tools} config for a prompt (⇄ getPromptConfig). DEFAULT = no row =
    {model: None, tools: []}. A missing table → default."""
    try:
        with connect() as c:
            row = c.execute(
                "SELECT model, tools FROM prompt_configs WHERE name=?", (name,)
            ).fetchone()
    except sqlite3.Error:
        return {"model": None, "tools": []}
    if not row:
        return {"model": None, "tools": []}
    try:
        tools = json.loads(row["tools"]) if row["tools"] else []
    except (ValueError, TypeError, json.JSONDecodeError):
        tools = []
    return {"model": row["model"], "tools": tools}


def all_prompt_overrides() -> dict[str, str]:
    """Return {name: instructions} for every persisted instruction override (⇄ for apply_overrides
    to bulk-apply). Empty dict when the table is absent or empty (→ apply_overrides is a no-op)."""
    try:
        with connect() as c:
            rows = c.execute("SELECT name, instructions FROM prompt_overrides").fetchall()
    except sqlite3.Error:
        return {}
    return {r["name"]: r["instructions"] for r in rows}


async def list_parties(topic_id: str) -> list[dict]:
    async with get_engine().connect() as conn:
        rows = (
            await conn.execute(text("SELECT * FROM parties WHERE topic_id = :t"), {"t": topic_id})
        ).mappings().all()
    out = []
    for r in rows:
        out.append({
            "id": r["id"], "name": r["name"], "type": r["type"], "description": r["description"],
            "weight": r["weight"], "agenda": r["agenda"], "stance": r["stance"],
            "means": json.loads(r["means"] or "[]"),
            "weight_factors": json.loads(r["weight_factors"] or "{}"),
            # Full shape for frontend parity (⇄ TS dbGetParties): circle, vulnerabilities, weight_evidence.
            "weight_evidence": json.loads(r["weight_evidence"] or "{}"),
            "circle": json.loads(r["circle"] or '{"visible": [], "shadow": []}'),
            "vulnerabilities": json.loads(r["vulnerabilities"] or "[]"),
            "auto_discovered": bool(r["auto_discovered"]), "user_verified": bool(r["user_verified"]),
        })
    return out


async def list_clues(topic_id: str) -> list[dict]:
    sql = (
        "SELECT c.id AS id, c.status AS status, cv.title AS title, "
        "cv.bias_corrected_summary AS summary, cv.clue_type AS clue_type, "
        "cv.relevance_score AS relevance, cv.party_relevance AS party_relevance, "
        "cv.domain_tags AS domain_tags, cv.source_credibility AS source_credibility, "
        "cv.key_points AS key_points, cv.fact_check AS fact_check "
        "FROM clues c JOIN clue_versions cv "
        "ON cv.clue_id = c.id AND cv.topic_id = c.topic_id AND cv.version = c.current_version "
        "WHERE c.topic_id = :t ORDER BY cv.relevance_score DESC"
    )
    async with get_engine().connect() as conn:
        rows = (await conn.execute(text(sql), {"t": topic_id})).mappings().all()
    out = []
    for r in rows:
        cred = json.loads(r["source_credibility"] or "{}")
        fc = json.loads(r["fact_check"] or "{}")
        # ⇄ TS clueMap build: adjusted_credibility ?? raw; adjusted_bias_flags ?? source_credibility.bias_flags.
        raw_credibility = cred.get("score")
        adj = fc.get("adjusted_credibility")
        credibility = adj if adj is not None else raw_credibility
        out.append({
            "id": r["id"], "status": r["status"], "title": r["title"], "summary": r["summary"],
            "clue_type": r["clue_type"], "relevance": r["relevance"],
            "party_relevance": json.loads(r["party_relevance"] or "[]"),
            "domain_tags": json.loads(r["domain_tags"] or "[]"),
            "key_points": json.loads(r["key_points"] or "[]"),
            "credibility": credibility,
            "raw_credibility": raw_credibility,
            "bias_flags": fc.get("adjusted_bias_flags") or cred.get("bias_flags", []),
            "verdict": fc.get("verdict"),
            "counter_evidence": fc.get("counter_evidence", ""),
            "cui_bono": fc.get("cui_bono", ""),
            "bias_analysis": fc.get("bias_analysis", ""),
            "sources": [s.get("url") for s in cred.get("origin_sources", [])],
        })
    return out


async def list_clues_api(topic_id: str) -> list[dict]:
    """Frontend-shaped clues (⇄ TS dbGetClues): each clue is {id, status, added_by, added_at,
    last_updated_at, current: <version#>, versions: [<full version objects>]} — the shape the
    React app consumes (clue.current + clue.versions[].*). Distinct from list_clues(), which
    returns the flat current-version view that server-py's own pipeline stages rely on."""
    async with get_engine().connect() as conn:
        clues = (await conn.execute(
            text("SELECT id,status,added_by,added_at,last_updated_at,current_version "
                 "FROM clues WHERE topic_id=:t"), {"t": topic_id},
        )).mappings().all()
        vrows = (await conn.execute(
            text("SELECT * FROM clue_versions WHERE topic_id=:t ORDER BY clue_id, version"),
            {"t": topic_id},
        )).mappings().all()
    by_clue: dict[str, list] = {}
    for v in vrows:
        by_clue.setdefault(v["clue_id"], []).append({
            "v": v["version"], "title": v["title"], "date": v["date"],
            "timeline_date": v["timeline_date"], "clue_type": v["clue_type"],
            "relevance_score": v["relevance_score"],
            "party_relevance": json.loads(v["party_relevance"] or "[]"),
            "domain_tags": json.loads(v["domain_tags"] or "[]"),
            "bias_corrected_summary": v["bias_corrected_summary"], "change_note": v["change_note"],
            "key_points": json.loads(v["key_points"] or "[]"),
            "fact_check": json.loads(v["fact_check"] or "{}"),
            "raw_source": json.loads(v["raw_source"] or "{}"),
            "source_credibility": json.loads(v["source_credibility"] or "{}"),
        })
    return [{
        "id": c["id"], "status": c["status"], "added_by": c["added_by"],
        "added_at": c["added_at"], "last_updated_at": c["last_updated_at"],
        "current": c["current_version"], "versions": by_clue.get(c["id"], []),
    } for c in clues]


async def list_representatives(topic_id: str) -> list[dict]:
    async with get_engine().connect() as conn:
        rows = (
            await conn.execute(text("SELECT * FROM representatives WHERE topic_id=:t"), {"t": topic_id})
        ).mappings().all()
    return [{
        "id": r["id"], "party_id": r["party_id"],
        "persona_title": r["persona_title"], "persona_prompt": r["persona_prompt"],
        "speaking_weight": r["speaking_weight"],
        "speaking_budget": json.loads(r["speaking_budget"] or "{}"),
        "auto_generated": bool(r["auto_generated"]),
    } for r in rows]


async def list_states(topic_id: str) -> list[dict]:
    """⇄ TS dbGetAllStates → rowToState. Version-history for the version selector.
    No 404 guard — unknown topic returns []. Returns the FULL KnowledgeState shape."""
    async with get_engine().connect() as conn:
        rows = (await conn.execute(
            text("SELECT * FROM states WHERE topic_id=:t ORDER BY version ASC"), {"t": topic_id}
        )).mappings().all()
    out = []
    for r in rows:
        try:
            clue_snap = json.loads(r["clue_snapshot"]) if r["clue_snapshot"] else {"count": 0, "ids_and_versions": {}}
        except (ValueError, TypeError, json.JSONDecodeError):
            clue_snap = {"count": 0, "ids_and_versions": {}}
        try:
            completed = json.loads(r["completed_stages"]) if r["completed_stages"] else []
        except (ValueError, TypeError, json.JSONDecodeError):
            completed = []
        try:
            delta_summary = json.loads(r["delta_summary"]) if r["delta_summary"] else None
        except (ValueError, TypeError, json.JSONDecodeError):
            delta_summary = None
        out.append({
            "version": r["version"], "label": r["label"], "created_at": r["created_at"],
            "trigger": r["trigger"], "clue_snapshot": clue_snap,
            "forum_session_id": r["forum_session_id"], "verdict_id": r["verdict_id"],
            "delta_from": r["delta_from"], "delta_summary": delta_summary,
            "parent_version": r["parent_version"], "fork_stage": r["fork_stage"],
            "version_status": r["version_status"] or "complete",
            "parties_snapshot": r["parties_snapshot"], "representatives_snapshot": r["representatives_snapshot"],
            "completed_stages": completed,
        })
    return out


async def get_resolution(topic_id: str, version: int) -> dict | None:
    async with get_engine().connect() as conn:
        r = (await conn.execute(
            text("SELECT * FROM forecast_resolutions WHERE topic_id=:t AND version=:v"),
            {"t": topic_id, "v": version},
        )).mappings().first()
    if not r:
        return None
    return {
        "topic_id": r["topic_id"], "version": r["version"], "resolved_scenario_id": r["resolved_scenario_id"],
        "resolved_at": r["resolved_at"], "notes": r["notes"], "brier_score": r["brier_score"],
        "log_score": r["log_score"], "forecast": json.loads(r["forecast"] or "[]"),
    }


async def list_resolutions() -> list[dict]:
    async with get_engine().connect() as conn:
        rows = (await conn.execute(text(
            "SELECT fr.*, t.title AS topic_title FROM forecast_resolutions fr "
            "LEFT JOIN topics t ON t.id = fr.topic_id ORDER BY fr.resolved_at DESC"
        ))).mappings().all()
    return [{
        "topic_id": r["topic_id"], "version": r["version"], "resolved_scenario_id": r["resolved_scenario_id"],
        "resolved_at": r["resolved_at"], "notes": r["notes"], "brier_score": r["brier_score"],
        "log_score": r["log_score"], "forecast": json.loads(r["forecast"] or "[]"),
        "topic_title": r["topic_title"],
    } for r in rows]


async def get_app_settings() -> dict | None:
    async with get_engine().connect() as conn:
        r = (await conn.execute(
            text("SELECT value FROM app_settings WHERE key='app_settings'")
        )).mappings().first()
    return json.loads(r["value"]) if r else None


def _turn_row(r) -> dict:
    return {
        "id": r["id"], "party_id": r["party_id"], "representative_id": r["representative_id"],
        "party_name": r["party_name"], "persona_title": r["persona_title"], "position": r["position"],
        "evidence": json.loads(r["evidence"] or "[]"), "challenges": json.loads(r["challenges"] or "[]"),
        "concessions": json.loads(r["concessions"] or "[]"), "statement": r["statement"],
        "scenario_endorsement": r["scenario_endorsement"], "clues_cited": json.loads(r["clues_cited"] or "[]"),
        "word_count": r["word_count"], "round": r["round"], "type": r["type"], "timestamp": r["created_at"],
        "moderator_directive": r["moderator_directive"], "moderator_reason": r["moderator_reason"],
    }


async def get_forum_session(topic_id: str, version: int | None = None, session_id: str | None = None) -> dict | None:
    """⇄ dbGetForumSession — full nested ForumSession (rounds→turns, scenarios, summary)."""
    async with get_engine().connect() as conn:
        if session_id:
            sess = (await conn.execute(
                text("SELECT * FROM forum_sessions WHERE id=:s AND topic_id=:t"), {"s": session_id, "t": topic_id}
            )).mappings().first()
        elif version is not None:
            sess = (await conn.execute(
                text("SELECT * FROM forum_sessions WHERE topic_id=:t AND version=:v"), {"t": topic_id, "v": version}
            )).mappings().first()
        else:
            sess = (await conn.execute(
                text("SELECT * FROM forum_sessions WHERE topic_id=:t ORDER BY version DESC LIMIT 1"), {"t": topic_id}
            )).mappings().first()
        if not sess:
            return None
        sid = sess["id"]
        rounds = (await conn.execute(
            text("SELECT * FROM forum_rounds WHERE session_id=:s AND topic_id=:t ORDER BY round_number"),
            {"s": sid, "t": topic_id},
        )).mappings().all()
        turns = (await conn.execute(
            text("SELECT * FROM forum_turns WHERE topic_id=:t ORDER BY round_id, rowid"), {"t": topic_id}
        )).mappings().all()
        scen = (await conn.execute(
            text("SELECT * FROM forum_scenarios WHERE session_id=:s AND topic_id=:t"), {"s": sid, "t": topic_id}
        )).mappings().all()
        summ = (await conn.execute(
            text("SELECT summary FROM forum_scenario_summaries WHERE session_id=:s AND topic_id=:t"),
            {"s": sid, "t": topic_id},
        )).mappings().first()

    turns_by_round: dict[int, list] = {}
    for t in turns:
        turns_by_round.setdefault(t["round_id"], []).append(_turn_row(t))
    out_rounds = [{"round": r["round_number"], "type": r["round_type"],
                   "turns": turns_by_round.get(r["id"], [])} for r in rounds]
    scenarios = [{
        "id": s["id"], "title": s["title"], "description": s["description"], "proposed_by": s["proposed_by"],
        "supported_by": json.loads(s["supported_by"] or "[]"), "contested_by": json.loads(s["contested_by"] or "[]"),
        "clues_cited": json.loads(s["clues_cited"] or "[]"), "benefiting_parties": json.loads(s["benefiting_parties"] or "[]"),
        "required_conditions": json.loads(s["required_conditions"] or "[]"),
        "falsification_conditions": json.loads(s["falsification_conditions"] or "[]"),
    } for s in scen]
    return {
        "session_id": sid, "version": sess["version"], "type": sess["type"], "status": sess["status"],
        "started_at": sess["started_at"], "completed_at": sess["completed_at"],
        "rounds": out_rounds, "scenarios": scenarios,
        "scenario_summary": json.loads(summ["summary"]) if summ else None,
        "debate_summary": sess["debate_summary"],
    }


async def get_expert_council(topic_id: str, version: int | None = None) -> dict | None:
    """⇄ dbGet(Latest)ExpertCouncil — returns ExpertCouncilOutput or None."""
    async with get_engine().connect() as conn:
        if version is None:
            vrow = (
                await conn.execute(
                    text("SELECT version FROM expert_councils WHERE topic_id=:t ORDER BY version DESC LIMIT 1"),
                    {"t": topic_id},
                )
            ).mappings().first()
            if not vrow:
                return None
            version = vrow["version"]
        council = (
            await conn.execute(
                text("SELECT * FROM expert_councils WHERE topic_id=:t AND version=:v"),
                {"t": topic_id, "v": version},
            )
        ).mappings().first()
        if not council:
            return None
        verdict = (
            await conn.execute(
                text("SELECT * FROM final_verdicts WHERE council_id=:c"), {"c": council["id"]}
            )
        ).mappings().first()
    final_verdict = None
    if verdict:
        final_verdict = {
            "synthesized_at": verdict["synthesized_at"],
            "scenarios_ranked": json.loads(verdict["scenarios_ranked"] or "[]"),
            "final_assessment": verdict["final_assessment"],
            "confidence_note": verdict["confidence_note"],
            "weight_challenge_decisions": json.loads(verdict["weight_challenge_decisions"] or "[]"),
            "debate_summary": verdict["debate_summary"],
            "steering": json.loads(verdict["steering"]) if verdict["steering"] else None,
        }
    return {
        "version": council["version"],
        "verdict_id": council["verdict_id"] or f"verdict-v{council['version']}",
        "experts": json.loads(council["experts"] or "[]"),
        "deliberations": [],
        "final_verdict": final_verdict,
        "evidence_map": json.loads(council["evidence_map"]) if council["evidence_map"] else [],
    }

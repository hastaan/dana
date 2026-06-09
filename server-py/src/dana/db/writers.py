"""Pipeline write paths (⇄ TS db/queries/{topics,parties,clues,researchCorpus}.ts).

JSON columns are stored exactly as the TS backend's JSON.stringify produces them, so the
shared schema round-trips. Sync (engine thread).
"""
import hashlib
import json
import re
import sqlite3
import time
from datetime import datetime, timezone

from .sync_db import connect

ISO = lambda: datetime.now(timezone.utc).isoformat()  # noqa: E731


def slugify(name: str, maxlen: int = 30) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    return s[:maxlen] or "x"


# ── Topics ────────────────────────────────────────────────────────────────────
DEFAULT_MODELS = {
    "data_gathering": "minimax-m3",
    "extraction": "minimax-m3",
    "enrichment": "minimax-m3",
    "delta_updates": "minimax-m3",
    "forum_reasoning": "minimax-m3",
    "expert_council": "minimax-m3",
    "verdict": "minimax-m3",
}


def create_topic(title: str, description: str = "") -> dict:
    tid = f"{slugify(title, 60)}-{int(time.time() * 1000):x}"
    now = ISO()
    topic = {
        "id": tid, "title": title, "description": description, "status": "draft",
        "current_version": 0, "models": DEFAULT_MODELS, "settings": {},
        "created_at": now, "updated_at": now,
    }
    with connect() as c:
        c.execute(
            "INSERT INTO topics (id,title,description,status,current_version,models,settings,created_at,updated_at)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (tid, title, description, "draft", 0, json.dumps(DEFAULT_MODELS), "{}", now, now),
        )
    return topic


def set_topic_status(topic_id: str, status: str) -> None:
    with connect() as c:
        c.execute("UPDATE topics SET status=?, updated_at=? WHERE id=?", (status, ISO(), topic_id))


# ── Deletes (card actions: DELETE /topics/:id, …/parties/:id, …/clues/:id) ──────
# Every topic-scoped table carries a `topic_id`. Not all declare ON DELETE CASCADE
# (forum_rounds/scratchpads/supervisor_state/synthesis_cache don't), so we wipe each
# explicitly with FK enforcement OFF — child-table order then can't trip a restrict/
# cascade ordering error, and no rows are orphaned.
_TOPIC_CHILD_TABLES = (
    "clue_versions", "clues", "parties", "states", "representatives",
    "forum_turns", "forum_rounds", "forum_scenarios", "forum_scenario_summaries",
    "forum_scratchpads", "forum_supervisor_state", "forum_sessions",
    "expert_assessments", "final_verdicts", "expert_councils",
    "research_searches", "research_pages", "forecast_resolutions", "synthesis_cache",
)


def delete_topic(topic_id: str) -> bool:
    """Delete a topic and ALL its data. Returns False if the topic didn't exist."""
    with connect() as c:
        c.execute("PRAGMA foreign_keys=OFF")  # before any DML; explicit full wipe below
        existed = c.execute("SELECT 1 FROM topics WHERE id=?", (topic_id,)).fetchone() is not None
        for tbl in _TOPIC_CHILD_TABLES:
            c.execute(f"DELETE FROM {tbl} WHERE topic_id=?", (topic_id,))
        c.execute("DELETE FROM topics WHERE id=?", (topic_id,))
        return existed


def delete_party(topic_id: str, party_id: str) -> bool:
    """Delete one party. Also removes its representatives so nothing dangles."""
    with connect() as c:
        existed = c.execute(
            "SELECT 1 FROM parties WHERE id=? AND topic_id=?", (party_id, topic_id)
        ).fetchone() is not None
        c.execute("DELETE FROM representatives WHERE topic_id=? AND party_id=?", (topic_id, party_id))
        c.execute("DELETE FROM parties WHERE id=? AND topic_id=?", (party_id, topic_id))
        return existed


def delete_clue(topic_id: str, clue_id: str) -> bool:
    """Delete one clue and all its versions."""
    with connect() as c:
        existed = c.execute(
            "SELECT 1 FROM clues WHERE id=? AND topic_id=?", (clue_id, topic_id)
        ).fetchone() is not None
        c.execute("DELETE FROM clue_versions WHERE clue_id=? AND topic_id=?", (clue_id, topic_id))
        c.execute("DELETE FROM clues WHERE id=? AND topic_id=?", (clue_id, topic_id))
        return existed


# ── Parties ───────────────────────────────────────────────────────────────────
def set_parties(topic_id: str, parties: list[dict]) -> None:
    """Replace the topic's parties (⇄ dbSetParties)."""
    with connect() as c:
        c.execute("DELETE FROM parties WHERE topic_id=?", (topic_id,))
        for p in parties:
            c.execute(
                "INSERT INTO parties (id,topic_id,name,type,description,weight,weight_factors,weight_evidence,"
                "agenda,means,circle,stance,vulnerabilities,auto_discovered,user_verified)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    p["id"], topic_id, p["name"], p.get("type", "non_state"), p.get("description", ""),
                    p.get("weight", 0),
                    json.dumps(p.get("weight_factors", {})), json.dumps(p.get("weight_evidence", {})),
                    p.get("agenda", ""), json.dumps(p.get("means", [])),
                    json.dumps(p.get("circle", {"visible": [], "shadow": []})),
                    p.get("stance", "active"), json.dumps(p.get("vulnerabilities", [])),
                    1 if p.get("auto_discovered", True) else 0,
                    1 if p.get("user_verified", False) else 0,
                ),
            )


def update_party_weight(topic_id: str, party_id: str, weight: float,
                         weight_factors: dict, weight_evidence: dict) -> None:
    with connect() as c:
        c.execute(
            "UPDATE parties SET weight=?, weight_factors=?, weight_evidence=? WHERE id=? AND topic_id=?",
            (weight, json.dumps(weight_factors), json.dumps(weight_evidence), party_id, topic_id),
        )


def save_representatives(topic_id: str, reps: list[dict]) -> None:
    """Replace the topic's representatives (⇄ dbSaveRepresentatives)."""
    with connect() as c:
        c.execute("DELETE FROM representatives WHERE topic_id=?", (topic_id,))
        for r in reps:
            c.execute(
                "INSERT INTO representatives (id,topic_id,party_id,persona_title,persona_prompt,"
                "speaking_weight,speaking_budget,auto_generated) VALUES (?,?,?,?,?,?,?,?)",
                (
                    r["id"], topic_id, r["party_id"], r.get("persona_title", ""),
                    r.get("persona_prompt", ""), r.get("speaking_weight", 0),
                    json.dumps(r.get("speaking_budget", {})),
                    1 if r.get("auto_generated", True) else 0,
                ),
            )


# ── Clues ─────────────────────────────────────────────────────────────────────
def add_clue(topic_id: str, clue: dict) -> str:
    """Insert a clue + its v1 clue_version (⇄ storeClue). Returns clue_id."""
    cid = clue.get("id") or f"clue-{int(time.time() * 1000):x}-{slugify(clue.get('title', ''), 12)}"
    now = ISO()
    raw_source = {
        "urls": clue.get("source_urls", []),
        "outlets": clue.get("source_outlets", []),
        "fetched_at": now,
    }
    source_credibility = {
        "score": clue.get("credibility", 50),
        "notes": clue.get("credibility_notes", ""),
        "bias_flags": clue.get("bias_flags", []),
        "origin_sources": [
            {"url": u, "outlet": (clue.get("source_outlets", []) + [""] * len(clue.get("source_urls", [])))[i], "is_republication": False}
            for i, u in enumerate(clue.get("source_urls", []))
        ],
    }
    with connect() as c:
        c.execute(
            "INSERT INTO clues (id,topic_id,current_version,status,added_by,added_at,last_updated_at)"
            " VALUES (?,?,?,?,?,?,?)",
            (cid, topic_id, 1, clue.get("status", "pending"), clue.get("added_by", "auto"), now, now),
        )
        c.execute(
            "INSERT INTO clue_versions (clue_id,topic_id,version,date,title,raw_source,source_credibility,"
            "bias_corrected_summary,relevance_score,party_relevance,domain_tags,timeline_date,clue_type,"
            "change_note,key_points,fact_check) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                cid, topic_id, 1, clue.get("date", now[:10]), clue.get("title", ""),
                json.dumps(raw_source), json.dumps(source_credibility),
                clue.get("summary", ""), clue.get("relevance", 50),
                json.dumps(clue.get("party_relevance", [])), json.dumps(clue.get("domain_tags", [])),
                clue.get("timeline_date", now[:10]), clue.get("clue_type", "event"),
                clue.get("change_note", "STORM research"), json.dumps(clue.get("key_points", [])),
                json.dumps(clue.get("fact_check", {})),
            ),
        )
    return cid


def count_clues(topic_id: str) -> int:
    with connect() as c:
        return c.execute("SELECT COUNT(*) FROM clues WHERE topic_id=?", (topic_id,)).fetchone()[0]


# ── Research corpus cache (⇄ researchCorpus.ts) ────────────────────────────────
def corpus_find_search(topic_id: str, query: str, max_age_hours: float = 24.0) -> list[dict] | None:
    with connect() as c:
        row = c.execute(
            "SELECT results, searched_at FROM research_searches WHERE topic_id=? AND query=? "
            "ORDER BY searched_at DESC LIMIT 1",
            (topic_id, query),
        ).fetchone()
    if not row:
        return None
    try:
        age = time.time() - datetime.fromisoformat(row["searched_at"]).timestamp()
        if age > max_age_hours * 3600:
            return None
        return json.loads(row["results"])
    except Exception:  # noqa: BLE001
        return None


def corpus_store_search(topic_id: str, query: str, results: list[dict], stage: str = "discovery") -> None:
    with connect() as c:
        c.execute(
            "INSERT INTO research_searches (topic_id,query,results,result_count,searched_at,stage)"
            " VALUES (?,?,?,?,?,?)",
            (topic_id, query, json.dumps(results), len(results), ISO(), stage),
        )


# ── Forum (⇄ db/queries/forum.ts) ──────────────────────────────────────────────
def create_forum_session(topic_id: str, version: int, type_: str = "full") -> str:
    session_id = f"forum-session-v{version}"
    with connect() as c:
        # Purge any prior artifacts for this session so re-runs don't accumulate / mix turns
        # (the dev DB may already carry a forum from the TS backend under the same session id).
        c.execute(
            "DELETE FROM forum_turns WHERE topic_id=? AND round_id IN "
            "(SELECT id FROM forum_rounds WHERE session_id=? AND topic_id=?)",
            (topic_id, session_id, topic_id),
        )
        c.execute("DELETE FROM forum_rounds WHERE session_id=? AND topic_id=?", (session_id, topic_id))
        c.execute("DELETE FROM forum_scenarios WHERE session_id=? AND topic_id=?", (session_id, topic_id))
        c.execute("DELETE FROM forum_scenario_summaries WHERE session_id=? AND topic_id=?", (session_id, topic_id))
        c.execute("DELETE FROM forum_sessions WHERE id=? AND topic_id=?", (session_id, topic_id))
        c.execute(
            "INSERT INTO forum_sessions (id,topic_id,version,type,status,started_at)"
            " VALUES (?,?,?,?,?,?)",
            (session_id, topic_id, version, type_, "running", ISO()),
        )
    return session_id


def add_forum_round(session_id: str, topic_id: str, round_number: int, round_type: str = "debate") -> int:
    with connect() as c:
        cur = c.execute(
            "INSERT INTO forum_rounds (session_id,topic_id,round_number,round_type) VALUES (?,?,?,?)",
            (session_id, topic_id, round_number, round_type),
        )
        return cur.lastrowid


def add_forum_turn(topic_id: str, round_id: int, turn: dict) -> None:
    with connect() as c:
        c.execute(
            "INSERT INTO forum_turns (id,round_id,topic_id,party_id,representative_id,party_name,"
            "persona_title,position,evidence,challenges,concessions,statement,scenario_endorsement,"
            "clues_cited,word_count,round,type,created_at,moderator_directive,moderator_reason)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                turn["id"], round_id, topic_id, turn["party_id"], turn["representative_id"],
                turn.get("party_name", ""), turn.get("persona_title"), turn.get("position"),
                json.dumps(turn.get("evidence", [])), json.dumps(turn.get("challenges", [])),
                json.dumps(turn.get("concessions", [])), turn.get("statement", ""),
                turn.get("scenario_endorsement"), json.dumps(turn.get("clues_cited", [])),
                turn.get("word_count", 0), turn.get("round", 1), turn.get("type", "other"),
                ISO(), turn.get("moderator_directive"), turn.get("moderator_reason"),
            ),
        )


def save_forum_scenarios(session_id: str, topic_id: str, scenarios: list[dict]) -> None:
    with connect() as c:
        c.execute("DELETE FROM forum_scenarios WHERE session_id=? AND topic_id=?", (session_id, topic_id))
        for s in scenarios:
            c.execute(
                "INSERT INTO forum_scenarios (id,session_id,topic_id,title,description,proposed_by,"
                "supported_by,contested_by,clues_cited,benefiting_parties,required_conditions,"
                "falsification_conditions) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    s["id"], session_id, topic_id, s.get("title", ""), s.get("description", ""),
                    s.get("proposed_by", ""), json.dumps(s.get("supported_by", [])),
                    json.dumps(s.get("contested_by", [])), json.dumps(s.get("clues_cited", [])),
                    json.dumps(s.get("benefiting_parties", [])), json.dumps(s.get("required_conditions", [])),
                    json.dumps(s.get("falsification_conditions", [])),
                ),
            )


def save_forum_scenario_summary(session_id: str, topic_id: str, summary: dict) -> None:
    with connect() as c:
        c.execute(
            "INSERT OR REPLACE INTO forum_scenario_summaries (session_id,topic_id,summary)"
            " VALUES (?,?,?)",
            (session_id, topic_id, json.dumps(summary)),
        )


def complete_forum_session(session_id: str, topic_id: str, debate_summary: str | None) -> None:
    with connect() as c:
        c.execute(
            "UPDATE forum_sessions SET status=?, completed_at=?, debate_summary=? WHERE id=? AND topic_id=?",
            ("complete", ISO(), debate_summary, session_id, topic_id),
        )


# ── Verdict (⇄ dbSaveExpertCouncil) ────────────────────────────────────────────
def save_verdict(
    topic_id: str,
    version: int,
    experts: list[dict],
    scenarios_ranked: list[dict],
    final_assessment: str,
    confidence_note: str,
    evidence_map: list[dict] | None = None,
    debate_summary: str | None = None,
) -> str:
    """Replace topic+version's expert_council + final_verdict (allows re-runs). Returns
    verdict_id. Drops any stale forecast_resolutions for the version (probabilities change)."""
    now = ISO()
    verdict_id = f"verdict-v{version}"
    with connect() as c:
        ex = c.execute(
            "SELECT id FROM expert_councils WHERE topic_id=? AND version=?", (topic_id, version)
        ).fetchone()
        if ex:
            cid = ex["id"]
            c.execute("DELETE FROM final_verdicts WHERE council_id=?", (cid,))
            c.execute("DELETE FROM expert_assessments WHERE council_id=?", (cid,))
            c.execute("DELETE FROM expert_councils WHERE id=?", (cid,))
            if c.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='forecast_resolutions'"
            ).fetchone():
                c.execute(
                    "DELETE FROM forecast_resolutions WHERE topic_id=? AND version=?", (topic_id, version)
                )
        cur = c.execute(
            "INSERT INTO expert_councils (topic_id,version,verdict_id,created_at,experts,evidence_map)"
            " VALUES (?,?,?,?,?,?)",
            (topic_id, version, verdict_id, now, json.dumps(experts), json.dumps(evidence_map or [])),
        )
        council_id = cur.lastrowid
        c.execute(
            "INSERT INTO final_verdicts (council_id,topic_id,synthesized_at,scenarios_ranked,"
            "final_assessment,confidence_note,weight_challenge_decisions,debate_summary,steering)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (
                council_id, topic_id, now, json.dumps(scenarios_ranked),
                final_assessment, confidence_note, "[]", debate_summary, None,
            ),
        )
    return verdict_id


# ── Calibration (⇄ db/queries/calibration.ts) ──────────────────────────────────
def save_forecast_resolution(topic_id: str, version: int, resolved_scenario_id: str,
                             forecast: list[dict], brier_score: float,
                             log_score: float | None, notes: str | None) -> None:
    with connect() as c:
        c.execute(
            "INSERT OR REPLACE INTO forecast_resolutions "
            "(topic_id,version,resolved_scenario_id,resolved_at,notes,brier_score,log_score,forecast)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (topic_id, version, resolved_scenario_id, ISO(), notes, brier_score, log_score,
             json.dumps(forecast)),
        )


def delete_forecast_resolution(topic_id: str, version: int) -> bool:
    with connect() as c:
        cur = c.execute(
            "DELETE FROM forecast_resolutions WHERE topic_id=? AND version=?", (topic_id, version)
        )
        return cur.rowcount > 0


# ── App settings / steering (⇄ db/queries/settings.ts) ──────────────────────────
def set_app_settings(value: dict) -> None:
    with connect() as c:
        c.execute(
            "INSERT OR REPLACE INTO app_settings (key,value) VALUES ('app_settings', ?)",
            (json.dumps(value),),
        )


def set_topic_settings(topic_id: str, settings: dict) -> None:
    with connect() as c:
        c.execute("UPDATE topics SET settings=?, updated_at=? WHERE id=?",
                  (json.dumps(settings), ISO(), topic_id))


def corpus_get_page(topic_id: str, url: str) -> dict | None:
    with connect() as c:
        row = c.execute(
            "SELECT title, content FROM research_pages WHERE topic_id=? AND url=?", (topic_id, url)
        ).fetchone()
    return {"title": row["title"], "content": row["content"]} if row else None


def corpus_store_page(topic_id: str, url: str, title: str, content: str, stage: str = "discovery") -> None:
    with connect() as c:
        c.execute(
            "INSERT OR IGNORE INTO research_pages (topic_id,url,title,content,content_length,fetched_at,stage)"
            " VALUES (?,?,?,?,?,?,?)",
            (topic_id, url, title, content, len(content), ISO(), stage),
        )


# ── Prompt overrides (Lane A — instruction-override layer ⇄ TS routes/prompts.ts) ─
# model + tools live in `prompt_configs` (the table the TS backend already created — same
# columns: name, model, tools, updated_at). The instruction TEXT override has no home in
# that schema, so it lives in a dedicated `prompt_overrides` table created on demand. Both
# are keyed by the stable prompt NAME (see llm/prompts.py REGISTRY). DEFAULT = no row =
# byte-identical current behavior (the signature's own __doc__).
def set_prompt_config(name: str, model: str | None = None, tools: list[str] | None = None) -> dict:
    """Upsert the model/tools config for a prompt (⇄ setPromptConfig). Unset fields are
    preserved from the current row. Returns the resulting {model, tools}."""
    with connect() as c:
        c.execute(
            "CREATE TABLE IF NOT EXISTS prompt_configs ("
            "name TEXT PRIMARY KEY, model TEXT, tools TEXT NOT NULL DEFAULT '[]', updated_at TEXT)"
        )
        row = c.execute("SELECT model, tools FROM prompt_configs WHERE name=?", (name,)).fetchone()
        cur_model = row["model"] if row else None
        cur_tools = json.loads(row["tools"]) if row and row["tools"] else []
        next_model = model if model is not None else cur_model
        next_tools = tools if tools is not None else cur_tools
        c.execute(
            "INSERT INTO prompt_configs (name,model,tools,updated_at) VALUES (?,?,?,?) "
            "ON CONFLICT(name) DO UPDATE SET model=excluded.model, tools=excluded.tools, "
            "updated_at=excluded.updated_at",
            (name, next_model, json.dumps(next_tools), ISO()),
        )
    return {"model": next_model, "tools": next_tools}


def set_prompt_instructions(name: str, content: str) -> None:
    """Persist an instruction-text override for a prompt (⇄ writeFileSync on the .md)."""
    with connect() as c:
        c.execute(
            "CREATE TABLE IF NOT EXISTS prompt_overrides ("
            "name TEXT PRIMARY KEY, instructions TEXT NOT NULL, updated_at TEXT)"
        )
        c.execute(
            "INSERT INTO prompt_overrides (name,instructions,updated_at) VALUES (?,?,?) "
            "ON CONFLICT(name) DO UPDATE SET instructions=excluded.instructions, "
            "updated_at=excluded.updated_at",
            (name, content, ISO()),
        )


def clear_prompt_instructions(name: str) -> bool:
    """Drop a prompt's instruction-text override (⇄ reset → restore backup). Returns whether
    a row existed. Best-effort: a missing table means there was nothing to clear."""
    try:
        with connect() as c:
            cur = c.execute("DELETE FROM prompt_overrides WHERE name=?", (name,))
            return cur.rowcount > 0
    except sqlite3.Error:
        return False


# ── Synthesis cache (re-uses research_pages via a synthetic dana:// url key) ─────
def synthesis_url(level: str, query: str) -> str:
    """Synthetic url key under which a synthesized output is cached in research_pages."""
    return f"dana://{level}/" + hashlib.sha1(query.encode()).hexdigest()[:16]


def cache_synthesis(topic_id: str, level: str, query: str, payload: dict) -> None:
    """Persist a synthesized output (deep_lookup answer / deep_search briefing) in a dedicated
    synthesis_cache table, so re-runs are cheap. The table has NO foreign key, so ad-hoc
    topic_ids from the HTTP facade (e.g. 'adhoc-lookup') cache too — unlike research_pages,
    whose FK silently rejected them. Best-effort: a failed store must never break the lookup."""
    try:
        content = json.dumps(payload)
        with connect() as c:
            c.execute(
                "CREATE TABLE IF NOT EXISTS synthesis_cache ("
                "key TEXT PRIMARY KEY, topic_id TEXT, level TEXT, query TEXT, "
                "content TEXT NOT NULL, fetched_at TEXT NOT NULL)"
            )
            c.execute(
                "INSERT OR REPLACE INTO synthesis_cache (key,topic_id,level,query,content,fetched_at)"
                " VALUES (?,?,?,?,?,?)",
                (synthesis_url(level, query), topic_id, level, query[:200], content, ISO()),
            )
    except sqlite3.Error:
        pass

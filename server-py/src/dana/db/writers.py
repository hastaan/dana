"""Pipeline write paths (⇄ TS db/queries/{topics,parties,clues,researchCorpus}.ts).

JSON columns are stored exactly as the TS backend's JSON.stringify produces them, so the
shared schema round-trips. Sync (engine thread).
"""
import json
import re
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

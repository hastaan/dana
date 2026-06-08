"""Async read helpers for parties and clues (current version), shaped for the API."""
import json

from sqlalchemy import text

from .engine import get_engine


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
            "auto_discovered": bool(r["auto_discovered"]), "user_verified": bool(r["user_verified"]),
        })
    return out


async def list_clues(topic_id: str) -> list[dict]:
    sql = (
        "SELECT c.id AS id, c.status AS status, cv.title AS title, "
        "cv.bias_corrected_summary AS summary, cv.clue_type AS clue_type, "
        "cv.relevance_score AS relevance, cv.party_relevance AS party_relevance, "
        "cv.domain_tags AS domain_tags, cv.source_credibility AS source_credibility, "
        "cv.key_points AS key_points "
        "FROM clues c JOIN clue_versions cv "
        "ON cv.clue_id = c.id AND cv.topic_id = c.topic_id AND cv.version = c.current_version "
        "WHERE c.topic_id = :t ORDER BY cv.relevance_score DESC"
    )
    async with get_engine().connect() as conn:
        rows = (await conn.execute(text(sql), {"t": topic_id})).mappings().all()
    out = []
    for r in rows:
        cred = json.loads(r["source_credibility"] or "{}")
        out.append({
            "id": r["id"], "status": r["status"], "title": r["title"], "summary": r["summary"],
            "clue_type": r["clue_type"], "relevance": r["relevance"],
            "party_relevance": json.loads(r["party_relevance"] or "[]"),
            "domain_tags": json.loads(r["domain_tags"] or "[]"),
            "key_points": json.loads(r["key_points"] or "[]"),
            "credibility": cred.get("score"),
            "sources": [s.get("url") for s in cred.get("origin_sources", [])],
        })
    return out

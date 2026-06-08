"""Topic queries (⇄ TS db/queries/topics.ts). Returns dicts whose JSON field names
match the TS wire contract exactly so the React frontend works unchanged."""
import json
from typing import Any

from sqlalchemy import text

from .engine import get_engine


def _row_to_topic(r: Any) -> dict:
    return {
        "id": r["id"],
        "title": r["title"],
        "description": r["description"],
        "status": r["status"],
        "current_version": r["current_version"],
        "models": json.loads(r["models"] or "{}"),
        "settings": json.loads(r["settings"] or "{}"),
        "created_at": r["created_at"],
        "updated_at": r["updated_at"],
    }


async def list_topics() -> list[dict]:
    async with get_engine().connect() as conn:
        rows = (await conn.execute(text("SELECT * FROM topics ORDER BY created_at DESC"))).mappings().all()
    return [_row_to_topic(r) for r in rows]


async def get_topic(topic_id: str) -> dict | None:
    async with get_engine().connect() as conn:
        r = (
            await conn.execute(text("SELECT * FROM topics WHERE id = :id"), {"id": topic_id})
        ).mappings().first()
    return _row_to_topic(r) if r else None

"""Internet-lookup route — the unified three-tier research facade over HTTP.

POST /api/research/lookup  { query, level, ...params }  → { status, level, answer|content, sources[] }
Lets the frontend (and any caller) run quick / deep_lookup / deep_search with explicit args,
with graceful tier fallback. Heavy tiers run off the event loop.
"""
from fastapi import APIRouter
from pydantic import BaseModel

from ..research.internet import internet_lookup

router = APIRouter()


class LookupBody(BaseModel):
    query: str
    level: str = "deep_lookup"          # quick | deep_lookup | deep_search
    # pass-through knobs (only those relevant to the chosen level are used)
    top_k: int | None = None
    fetch_top: int | None = None
    max_sub_questions: int | None = None
    breadth: str | None = None          # deep_search: clue | topic | article
    max_personas: int | None = None
    max_turns: int | None = None
    persona: str | None = None
    language: str | None = None
    topic_id: str | None = None


@router.post("/api/research/lookup")
async def research_lookup(body: LookupBody):
    params = {k: v for k, v in body.model_dump().items()
              if k not in ("query", "level") and v is not None}
    return await internet_lookup(body.query, level=body.level, **params)

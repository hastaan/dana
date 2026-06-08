"""Pipeline routes (⇄ TS routes/pipeline.ts). Phase 1 wires the Discovery stage;
later phases add enrich/forum-prep/forum/score/analyze/run/update.

run_id matches the TS contract exactly: the literal stage name ("discover").
"""
from fastapi import APIRouter, HTTPException

from ..db import topics as topics_repo
from ..pipeline import discovery, scoring
from ..pipeline.runner import registry

router = APIRouter()


@router.post("/api/topics/{topic_id}/pipeline/discover")
async def discover(topic_id: str):
    topic = await topics_repo.get_topic(topic_id)
    if topic is None:
        raise HTTPException(status_code=404, detail={"message": "Topic not found"})

    async def work() -> None:
        await discovery.run_discovery(topic_id, topic["title"], topic["description"])

    started = await registry.start(topic_id, "discover", work)
    if started is None:
        raise HTTPException(status_code=409, detail={"message": "Pipeline already running"})
    return started


@router.post("/api/topics/{topic_id}/pipeline/score")
async def score(topic_id: str):
    topic = await topics_repo.get_topic(topic_id)
    if topic is None:
        raise HTTPException(status_code=404, detail={"message": "Topic not found"})

    async def work() -> None:
        await scoring.run_scoring(topic_id, topic["title"], topic["description"])

    started = await registry.start(topic_id, "score", work)
    if started is None:
        raise HTTPException(status_code=409, detail={"message": "Pipeline already running"})
    return started


@router.get("/api/topics/{topic_id}/pipeline/status")
async def status(topic_id: str):
    run = registry.active(topic_id)
    if run:
        return {"running": True, **run}
    return {"running": False}

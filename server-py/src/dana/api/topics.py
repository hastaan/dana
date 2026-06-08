from fastapi import APIRouter, HTTPException

from ..db import topics as topics_repo

router = APIRouter()


@router.get("/api/topics")
async def list_topics():
    return await topics_repo.list_topics()


@router.get("/api/topics/{topic_id}")
async def get_topic(topic_id: str):
    topic = await topics_repo.get_topic(topic_id)
    if topic is None:
        raise HTTPException(status_code=404, detail={"message": "Topic not found"})
    return topic

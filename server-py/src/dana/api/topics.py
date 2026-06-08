import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..db import reads
from ..db import topics as topics_repo
from ..db import writers

router = APIRouter()


class CreateTopic(BaseModel):
    title: str
    description: str = ""


@router.get("/api/topics")
async def list_topics():
    return await topics_repo.list_topics()


@router.post("/api/topics")
async def create_topic(body: CreateTopic):
    return await asyncio.to_thread(writers.create_topic, body.title, body.description)


@router.get("/api/topics/{topic_id}")
async def get_topic(topic_id: str):
    topic = await topics_repo.get_topic(topic_id)
    if topic is None:
        raise HTTPException(status_code=404, detail={"message": "Topic not found"})
    return topic


@router.get("/api/topics/{topic_id}/parties")
async def get_parties(topic_id: str):
    return await reads.list_parties(topic_id)


@router.get("/api/topics/{topic_id}/clues")
async def get_clues(topic_id: str):
    return await reads.list_clues(topic_id)


# ── Verdict / expert council (⇄ TS expertCouncil.ts) ───────────────────────────
@router.get("/api/topics/{topic_id}/expert-council")
async def get_expert_council(topic_id: str):
    return await reads.get_expert_council(topic_id)


@router.get("/api/topics/{topic_id}/expert-council/{version}")
async def get_expert_council_version(topic_id: str, version: int):
    data = await reads.get_expert_council(topic_id, version)
    if data is None:
        raise HTTPException(status_code=404, detail={"message": "Expert council not found for this version"})
    return data


@router.get("/api/topics/{topic_id}/verdict")
async def get_verdict(topic_id: str):
    council = await reads.get_expert_council(topic_id)
    return council.get("final_verdict") if council else None


@router.get("/api/topics/{topic_id}/verdict/{version}")
async def get_verdict_version(topic_id: str, version: int):
    council = await reads.get_expert_council(topic_id, version)
    return council.get("final_verdict") if council else None

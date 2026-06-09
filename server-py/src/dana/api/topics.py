import asyncio
import json

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..db import reads
from ..db import topics as topics_repo
from ..db import writers

router = APIRouter()


class CreateTopic(BaseModel):
    title: str
    description: str = ""


class AnalystGuidance(BaseModel):
    """Per-topic operator steering (guides METHOD, not the conclusion). All fields optional."""
    framing_note: str | None = None
    research_guidance: str | None = None
    evidence_guidance: str | None = None
    debate_guidance: str | None = None


class SteeringBody(BaseModel):
    steering: AnalystGuidance | None = None


def _topic_settings(topic: dict) -> dict:
    """topics.settings may be a JSON string or a dict depending on the read path."""
    s = topic.get("settings") or {}
    if isinstance(s, str):
        try:
            s = json.loads(s or "{}")
        except Exception:  # noqa: BLE001
            s = {}
    return s if isinstance(s, dict) else {}


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


@router.delete("/api/topics/{topic_id}")
async def delete_topic(topic_id: str):
    """Delete a topic and all its data (Dashboard TopicCard delete)."""
    await asyncio.to_thread(writers.delete_topic, topic_id)
    return {"success": True}


# ── Per-topic operator steering (Save guidance — TopicView/VerdictPanel) ───────────
# Stored in topics.settings.steering; the pipeline reads it via llm/steering.steering_for().
@router.get("/api/topics/{topic_id}/steering")
async def get_steering(topic_id: str):
    topic = await topics_repo.get_topic(topic_id)
    if topic is None:
        raise HTTPException(status_code=404, detail={"message": "Topic not found"})
    return {"steering": _topic_settings(topic).get("steering") or {}}


@router.put("/api/topics/{topic_id}/steering")
async def put_steering(topic_id: str, body: SteeringBody):
    topic = await topics_repo.get_topic(topic_id)
    if topic is None:
        raise HTTPException(status_code=404, detail={"message": "Topic not found"})
    settings = _topic_settings(topic)
    guidance = body.steering.model_dump() if body.steering else {}
    # Keep only the non-empty guidance fields (so clearing a field removes it).
    settings["steering"] = {k: v for k, v in guidance.items() if v}
    await asyncio.to_thread(writers.set_topic_settings, topic_id, settings)
    return {"steering": settings["steering"]}


@router.get("/api/topics/{topic_id}/parties")
async def get_parties(topic_id: str):
    return await reads.list_parties(topic_id)


@router.delete("/api/topics/{topic_id}/parties/{party_id}")
async def delete_party(topic_id: str, party_id: str):
    """Delete one party (PartiesPanel card delete)."""
    await asyncio.to_thread(writers.delete_party, topic_id, party_id)
    return {"success": True}


@router.get("/api/topics/{topic_id}/clues")
async def get_clues(topic_id: str):
    return await reads.list_clues_api(topic_id)


@router.delete("/api/topics/{topic_id}/clues/{clue_id}")
async def delete_clue(topic_id: str, clue_id: str):
    """Delete one clue and its versions (CluesPanel card delete)."""
    await asyncio.to_thread(writers.delete_clue, topic_id, clue_id)
    return {"success": True}


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


# ── Forum (⇄ TS forum.ts) ──────────────────────────────────────────────────────
@router.get("/api/topics/{topic_id}/representatives")
async def get_representatives(topic_id: str):
    return await reads.list_representatives(topic_id)


@router.get("/api/topics/{topic_id}/forum")
async def get_forum(topic_id: str, version: int | None = None):
    return await reads.get_forum_session(topic_id, version=version)


@router.get("/api/topics/{topic_id}/forum/{session_id}")
async def get_forum_by_session(topic_id: str, session_id: str):
    data = await reads.get_forum_session(topic_id, session_id=session_id)
    if data is None:
        raise HTTPException(status_code=404, detail={"message": "Forum session not found"})
    return data

"""Settings routes (⇄ TS routes/settings.ts): default models, analysis controls, steering."""
import asyncio

from fastapi import APIRouter
from pydantic import BaseModel

from ..db import reads, writers

router = APIRouter()

DEFAULT_SETTINGS = {
    "default_models": writers.DEFAULT_MODELS,
    "analysis_controls": {},
    "steering": {},
}


class AnalystGuidance(BaseModel):
    framing_note: str | None = None
    research_guidance: str | None = None
    evidence_guidance: str | None = None
    debate_guidance: str | None = None


class SettingsBody(BaseModel):
    default_models: dict | None = None
    analysis_controls: dict | None = None
    steering: AnalystGuidance | None = None


async def _current() -> dict:
    stored = await reads.get_app_settings()
    return {**DEFAULT_SETTINGS, **(stored or {})}


@router.get("/api/settings")
@router.get("/api/settings/")
async def get_settings():
    return await _current()


@router.put("/api/settings")
@router.put("/api/settings/")
async def put_settings(body: SettingsBody):
    cur = await _current()
    if body.default_models is not None:
        cur["default_models"] = {**cur.get("default_models", {}), **body.default_models}
    if body.analysis_controls is not None:
        cur["analysis_controls"] = {**cur.get("analysis_controls", {}), **body.analysis_controls}
    if body.steering is not None:
        # Keep only the non-null guidance fields.
        cur["steering"] = {k: v for k, v in body.steering.model_dump().items() if v}
    await asyncio.to_thread(writers.set_app_settings, cur)
    return cur

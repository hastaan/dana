from fastapi import APIRouter

from ..llm import lm

router = APIRouter()


@router.get("/api/models")
async def models():
    # ⇄ TS /api/models (fetchAvailableModels). Frontend expects [{ id }].
    return [{"id": mid} for mid in await lm.list_models()]

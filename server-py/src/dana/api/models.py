from fastapi import APIRouter

from ..llm import lm, model_catalog

router = APIRouter()


@router.get("/api/models")
async def models():
    # ⇄ TS /api/models (fetchAvailableModels). Frontend expects [{ id }].
    return [{"id": mid} for mid in await lm.list_models()]


@router.get("/api/models/catalog")
async def models_catalog():
    # ⇄ TS /api/models/catalog (getModelCatalog). CatalogEntry[] for the Settings pickers.
    return await model_catalog.get_model_catalog()

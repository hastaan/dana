"""FastAPI application factory.

Phase 0: health, topics (read), models (proxy), and the SSE event bus — enough to
serve the existing React frontend's first screens against the Python backend and to
prove the request -> DB / proxy / SSE plumbing. Subsequent phases mount the pipeline,
research engine, forum, scoring, calibration, providers, and steering routers.
"""
import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .api import calibration as calibration_api
from .api import internet as internet_api
from .api import models as models_api
from .api import pipeline as pipeline_api
from .api import providers as providers_api
from .api import settings as settings_api
from .api import stream as stream_api
from .api import topics as topics_api
from .config import settings
from .db.engine import dispose_engine
from .events.bus import bus


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Bind the running loop so the (thread-safe) event bus can schedule deliveries.
    bus.bind_loop(asyncio.get_running_loop())
    yield
    await dispose_engine()


def create_app() -> FastAPI:
    app = FastAPI(title="Dana (Python + DSPy)", version="0.1.0", lifespan=lifespan)

    # Mirrors the TS backend's open CORS (the frontend is same-origin in prod / Vite-proxied in dev).
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(topics_api.router)
    app.include_router(stream_api.router)
    app.include_router(models_api.router)
    app.include_router(pipeline_api.router)
    app.include_router(calibration_api.router)
    app.include_router(settings_api.router)
    app.include_router(providers_api.router)
    app.include_router(internet_api.router)

    @app.get("/health")
    @app.get("/api/health")
    async def health():
        return {"status": "ok"}

    # Full-cutover mode: if a built React frontend is present, serve it as the SPA so this
    # one process replaces the TS server entirely. Mounted LAST so /api/* routes win.
    dist = os.getenv("FRONTEND_DIST") or str(Path(__file__).resolve().parents[3] / "app" / "frontend" / "dist")
    if Path(dist).is_dir():
        app.mount("/", StaticFiles(directory=dist, html=True), name="spa")

    return app


app = create_app()

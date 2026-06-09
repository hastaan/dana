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
from .api.auth import ApiTokenMiddleware
from .api import models as models_api
from .api import pipeline as pipeline_api
from .api import prompts as prompts_api
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
    # Claim DSPy's settings owner on THIS (main) thread and set the global default LM once.
    # DSPy only lets the first-configuring thread call dspy.configure(); worker threads use
    # dspy_lm.lm_context() (thread-local) instead. Best-effort: the proxy may be unreachable
    # at boot (make_lm → pick_model does a network probe) — that must not crash startup, and
    # workers don't depend on this default anyway (each lm_context builds its own LM).
    from .llm import dspy_lm
    try:
        dspy_lm.configure()
    except Exception:  # noqa: BLE001
        pass
    yield
    await dispose_engine()


def create_app() -> FastAPI:
    app = FastAPI(title="Dana (Python + DSPy)", version="0.1.0", lifespan=lifespan)

    # Env-gated bearer-token auth on /api/* — a no-op unless env DANA_API_TOKEN is set/non-empty
    # (then /api/* requires `Authorization: Bearer <DANA_API_TOKEN>`; /health, /api/health, and
    # `?token=` on /stream endpoints are exempt). See api/auth.py. Added FIRST so that CORS (added
    # next) ends up OUTERMOST — Starlette's add_middleware prepends, so the last-added wraps the
    # rest. That way CORS still attaches the right headers to the auth 401 and answers preflight.
    app.add_middleware(ApiTokenMiddleware)

    # Mirrors the TS backend's open CORS (frontend is same-origin in prod / Vite-proxied in dev).
    # Added LAST → OUTERMOST, so every response (including the auth 401) carries CORS headers.
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
    app.include_router(prompts_api.router)

    @app.get("/health")
    @app.get("/api/health")
    async def health():
        return {"status": "ok"}

    # Full-cutover mode: if a built React frontend is present, serve it as the SPA so this
    # one process replaces the TS server entirely.
    dist = os.getenv("FRONTEND_DIST") or str(Path(__file__).resolve().parents[3] / "app" / "frontend" / "dist")
    dist_path = Path(dist)
    if dist_path.is_dir():
        # Serve built assets (/assets/*, favicon, etc.) from disk…
        app.mount("/assets", StaticFiles(directory=str(dist_path / "assets")), name="spa-assets")
        index_html = dist_path / "index.html"

        # …and history-API fallback: any non-/api, non-/health GET returns index.html so
        # client-side routes (/research, /settings, /topic/:id) work on refresh/deep-link.
        # Registered LAST so all real API routes still win.
        from fastapi import Request
        from fastapi.responses import FileResponse, Response

        @app.get("/{full_path:path}")
        async def spa_fallback(full_path: str, request: Request):
            if full_path.startswith(("api/", "stream", "health", "docs", "openapi")):
                return Response(status_code=404)
            candidate = dist_path / full_path
            if full_path and candidate.is_file():
                return FileResponse(candidate)
            return FileResponse(index_html)

    return app


app = create_app()

"""Env-gated bearer-token auth for /api/* (⇄ TS backend's optional API token).

OFF by default: if env DANA_API_TOKEN is unset/empty, every request passes through
unchanged (current behavior). If it is set, /api/* requires `Authorization: Bearer <token>`
and returns 401 JSON otherwise.

Exemptions:
  • health probes: /health, /api/health
  • SSE stream endpoints (path ends with /stream): EventSource can't set headers, so they
    may instead authenticate with a `?token=<token>` query param.

Wired as Starlette middleware in main.py so it covers every router uniformly.
"""
import os

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

# Paths that never require auth (health probes). The SPA/static mount and non-/api
# routes are also exempt — we only guard the JSON API surface.
_EXEMPT_PATHS = frozenset({"/health", "/api/health"})


def _expected_token() -> str:
    """The configured API token, or "" when auth is disabled. Read live from the env so
    the gate is data_dir-independent and reflects the process environment at request time."""
    return (os.getenv("DANA_API_TOKEN") or "").strip()


def _presented_token(request: Request) -> str | None:
    """Pull the bearer token from the Authorization header, or — for SSE stream endpoints,
    where EventSource cannot set headers — from the `?token=` query param."""
    auth = request.headers.get("authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    if request.url.path.endswith("/stream"):
        tok = request.query_params.get("token")
        if tok:
            return tok.strip()
    return None


class ApiTokenMiddleware(BaseHTTPMiddleware):
    """Require `Authorization: Bearer <DANA_API_TOKEN>` on /api/* when the env var is set.

    No-op when DANA_API_TOKEN is unset/empty, so the default deployment is unaffected.
    """

    async def dispatch(self, request: Request, call_next):
        expected = _expected_token()
        path = request.url.path
        if (
            expected                          # auth enabled
            and path.startswith("/api/")      # only guard the API surface
            and path not in _EXEMPT_PATHS     # health probes always allowed
        ):
            if _presented_token(request) != expected:
                return JSONResponse(
                    {"status": "error", "message": "unauthorized"},
                    status_code=401,
                )
        return await call_next(request)

"""LM access — the SINGLE chokepoint for all model calls (⇄ TS proxyClient.ts).

Everything (including DSPy, once wired in Phase 1) routes through here so the
model-availability fallback and rate limiting are enforced in one place — the review
flagged that per-model rate limiting is bypassed if calls fan out around the wrapper.

CLIProxyAPI is OpenAI-compatible, so DSPy/litellm will target it as
``openai/<model>`` with ``api_base = {proxy_base_url}/v1``.
"""
import time

import httpx

from ..config import settings

_models_cache: tuple[float, list[str]] | None = None
_MODELS_TTL = 300.0  # 5 min, matching the TS client


def _headers() -> dict:
    return {"Authorization": f"Bearer {settings.proxy_api_key}", "Content-Type": "application/json"}


async def list_models(force: bool = False) -> list[str]:
    global _models_cache
    now = time.monotonic()
    if not force and _models_cache and now - _models_cache[0] < _MODELS_TTL:
        return _models_cache[1]
    async with httpx.AsyncClient(timeout=10.0) as c:
        r = await c.get(f"{settings.proxy_base_url}/v1/models", headers=_headers())
        r.raise_for_status()
        ids = [m["id"] for m in r.json().get("data", [])]
    _models_cache = (now, ids)
    return ids


async def resolve_available_model(requested: str) -> str:
    """Fall back to an available model when the requested one isn't served
    (⇄ modelCatalog.resolveAvailableModel). Phase-0 fallback is first-available;
    tier-aware selection lands with model_catalog.py."""
    avail = await list_models()
    if not avail or requested in avail:
        return requested
    return avail[0]


async def chat(model: str, messages: list[dict], **kwargs) -> dict:
    resolved = await resolve_available_model(model)
    async with httpx.AsyncClient(timeout=300.0) as c:
        r = await c.post(
            f"{settings.proxy_base_url}/v1/chat/completions",
            headers=_headers(),
            json={"model": resolved, "messages": messages, "stream": False, **kwargs},
        )
        r.raise_for_status()
        return r.json()

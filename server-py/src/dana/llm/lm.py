"""LM access — the SINGLE chokepoint for all model calls (⇄ TS proxyClient.ts).

Everything (including DSPy, once wired in Phase 1) routes through here so the
model-availability fallback and rate limiting are enforced in one place — the review
flagged that per-model rate limiting is bypassed if calls fan out around the wrapper.

CLIProxyAPI is OpenAI-compatible, so DSPy/litellm will target it as
``openai/<model>`` with ``api_base = {proxy_base_url}/v1``.
"""
import asyncio
import time

import httpx

from ..config import settings
from .think import strip_think

_models_cache: tuple[float, list[str]] | None = None
_MODELS_TTL = 300.0  # 5 min, matching the TS client
_BACKOFF = (1.0, 5.0, 15.0)  # ⇄ TS proxyClient retry schedule


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


def invalidate_models() -> None:
    """Drop the cached model list so the next list_models() refetches (⇄ invalidateVerifiedModels)."""
    global _models_cache
    _models_cache = None


async def resolve_available_model(requested: str) -> str:
    """Fall back to an available model when the requested one isn't served
    (⇄ modelCatalog.resolveAvailableModel). Phase-0 fallback is first-available;
    tier-aware selection lands with model_catalog.py."""
    avail = await list_models()
    if not avail or requested in avail:
        return requested
    return avail[0]


async def chat(model: str, messages: list[dict], **kwargs) -> dict:
    """Single async completion. Retries on 429/5xx with backoff, then strips `<think>`
    blocks from the assistant message (⇄ TS proxyClient retry + the strip-think proxy)."""
    resolved = await resolve_available_model(model)
    payload = {"model": resolved, "messages": messages, "stream": False, **kwargs}
    last_err: Exception | None = None
    for attempt in range(len(_BACKOFF) + 1):
        try:
            async with httpx.AsyncClient(timeout=300.0) as c:
                r = await c.post(
                    f"{settings.proxy_base_url}/v1/chat/completions",
                    headers=_headers(), json=payload,
                )
            if r.status_code == 429 or r.status_code >= 500:
                raise httpx.HTTPStatusError(f"HTTP {r.status_code}", request=r.request, response=r)
            r.raise_for_status()
            data = r.json()
            for ch in data.get("choices", []):
                msg = ch.get("message")
                if msg and isinstance(msg.get("content"), str):
                    msg["content"] = strip_think(msg["content"])
            return data
        except (httpx.HTTPError, httpx.HTTPStatusError) as e:  # noqa: PERF203
            last_err = e
            if attempt < len(_BACKOFF):
                await asyncio.sleep(_BACKOFF[attempt])
    raise RuntimeError(f"chat failed after {len(_BACKOFF) + 1} attempts: {last_err}") from last_err

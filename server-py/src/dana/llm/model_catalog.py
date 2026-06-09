"""Model catalog (⇄ TS llm/modelCatalog.ts).

Fetches the remote models.json (router-for.me) into an in-memory cache (3h TTL), parses
each entry to a ModelMeta, derives a tier, and exposes get_model_catalog() which marks each
entry available iff its id is in the live proxy model list. Used by GET /api/models/catalog
(Settings model pickers).
"""
import asyncio
import re
import time

import httpx

from . import lm

MODELS_URLS = [
    "https://models.router-for.me/models.json",
    "https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/models.json",
]
_REFRESH_INTERVAL = 3 * 60 * 60.0  # 3h, ⇄ TS REFRESH_INTERVAL
_FETCH_TIMEOUT = 30.0

_catalog: dict[str, dict] = {}       # id -> ModelMeta
_fetched_at: float = 0.0
_lock = asyncio.Lock()


def _derive_tier(model_id: str) -> str:
    low = model_id.lower()
    if re.search(r"haiku|mini|spark|3-5-haiku|flash", low):
        return "fast"
    if re.search(r"opus|codex-max|gpt-5\.4", low):
        return "powerful"
    return "balanced"


def _parse_model(raw: dict) -> dict:
    model_id = raw.get("id") or raw.get("name") or ""
    type_ = raw.get("type") or ""
    supported = raw.get("supported_parameters") or []
    return {
        "id": model_id,
        "display_name": raw.get("display_name") or raw.get("displayName") or model_id,
        "description": raw.get("description") or "",
        "context_length": raw.get("context_length") or raw.get("inputTokenLimit") or 0,
        "max_completion_tokens": raw.get("max_completion_tokens") or raw.get("outputTokenLimit") or 0,
        "type": type_,
        "thinking": raw.get("thinking") or None,
        "supports_tools": ("tools" in supported) or type_ == "claude",
        "tier": _derive_tier(model_id),
    }


def _flatten(data: dict) -> dict[str, dict]:
    out: dict[str, dict] = {}
    if not isinstance(data, dict):
        return out
    for models in data.values():
        if not isinstance(models, list):
            continue
        for raw in models:
            if not isinstance(raw, dict):
                continue
            m = _parse_model(raw)
            if m["id"] and m["id"] not in out:  # first-id-wins dedup, ⇄ TS
                out[m["id"]] = m
    return out


async def _fetch_remote() -> dict[str, dict] | None:
    async with httpx.AsyncClient(timeout=_FETCH_TIMEOUT) as client:
        for url in MODELS_URLS:
            try:
                res = await client.get(url)
                if res.status_code >= 400:
                    continue
                mp = _flatten(res.json())
                if mp:
                    return mp
            except Exception:  # noqa: BLE001 — try the next mirror
                continue
    return None


async def _refresh_if_stale(force: bool = False) -> None:
    global _catalog, _fetched_at
    now = time.monotonic()
    if not force and _catalog and now - _fetched_at < _REFRESH_INTERVAL:
        return
    async with _lock:
        now = time.monotonic()
        if not force and _catalog and now - _fetched_at < _REFRESH_INTERVAL:
            return
        nxt = await _fetch_remote()
        if nxt:
            _catalog = nxt
            _fetched_at = now
        elif not _catalog:
            _fetched_at = now  # cache the empty result briefly so we don't refetch every request


async def get_model_catalog() -> list[dict]:
    """⇄ TS getModelCatalog: every cached ModelMeta + `available` (id in live proxy list).
    Proxy ids absent from the remote catalog are synthesized so the picker still lists them."""
    await _refresh_if_stale()
    try:
        available_ids = set(await lm.list_models())
    except Exception:  # noqa: BLE001 — proxy down: nothing is available
        available_ids = set()
    entries = [{**m, "available": m["id"] in available_ids} for m in _catalog.values()]
    known = {m["id"] for m in _catalog.values()}
    for mid in available_ids:
        if mid not in known:
            entries.append({
                "id": mid, "display_name": mid, "description": "",
                "context_length": 0, "max_completion_tokens": 0, "type": "",
                "thinking": None, "supports_tools": False,
                "tier": _derive_tier(mid), "available": True,
            })
    return entries

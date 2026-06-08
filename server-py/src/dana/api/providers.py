"""Provider routes (⇄ TS routes/providers.ts + customProviders.ts).

Focus: custom API-key providers (OpenAI-compatible + Anthropic-compatible) managed through
the CLIProxyAPI management API via read-modify-write. This is what lets an operator plug in
e.g. a MiniMax key from the UI. API keys are never echoed back — only a masked hint.

The interactive OAuth login flow (Google/Codex/Anthropic browser login) is not ported here;
custom API-key providers cover the key-based use case.
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..llm import lm, proxy_admin
from ..llm.proxy_admin import ManagementError, ManagementUnavailable

router = APIRouter()


def _mask(key: str | None) -> str:
    if not key:
        return ""
    return ("…" + key[-4:]) if len(key) > 4 else "…"


def _normalize_models(models) -> list[dict]:
    out = []
    for m in models or []:
        if isinstance(m, str):
            out.append({"name": m})
        elif isinstance(m, dict) and m.get("name"):
            entry = {"name": m["name"]}
            if m.get("alias"):
                entry["alias"] = m["alias"]
            out.append(entry)
    return out


def _openai_view(p: dict) -> dict:
    entries = p.get("api-key-entries") or []
    return {
        "kind": "openai", "id": p.get("name", ""), "name": p.get("name", ""),
        "base_url": p.get("base-url", ""), "models": p.get("models") or [],
        "key_hint": _mask(entries[0].get("api-key") if entries else ""),
        "disabled": bool(p.get("disabled", False)),
    }


def _anthropic_view(p: dict) -> dict:
    return {
        "kind": "anthropic", "id": p.get("base-url", ""), "name": p.get("base-url", ""),
        "base_url": p.get("base-url", ""), "models": p.get("models") or [],
        "key_hint": _mask(p.get("api-key")), "disabled": False,
    }


class CustomProviderBody(BaseModel):
    kind: str  # "openai" | "anthropic"
    name: str | None = None
    base_url: str
    api_key: str | None = None
    models: list | None = None


@router.get("/api/providers/custom")
@router.get("/api/providers/custom/")
async def list_custom():
    try:
        oa = await proxy_admin.list_openai_compat()
        an = await proxy_admin.list_claude_key()
    except ManagementUnavailable as e:
        raise HTTPException(status_code=503, detail={"message": str(e)})
    except ManagementError as e:
        raise HTTPException(status_code=502, detail={"message": str(e)})
    return {"providers": [_openai_view(p) for p in oa] + [_anthropic_view(p) for p in an]}


@router.get("/api/providers/custom/status")
async def custom_status():
    return await proxy_admin.management_status()


@router.post("/api/providers/custom")
@router.post("/api/providers/custom/")
async def upsert_custom(body: CustomProviderBody):
    models = _normalize_models(body.models)
    try:
        if body.kind == "openai":
            lst = await proxy_admin.list_openai_compat()
            name = body.name or body.base_url
            existing = next((p for p in lst if p.get("name") == name), None)
            key = body.api_key
            if not key and existing:  # blank key preserves the stored one
                entries = existing.get("api-key-entries") or [{}]
            else:
                entries = [{"api-key": key or ""}]
            entry = {"name": name, "base-url": body.base_url, "api-key-entries": entries,
                     "models": models or (existing.get("models") if existing else []) or []}
            lst = [p for p in lst if p.get("name") != name] + [entry]
            await proxy_admin.put_openai_compat(lst)
        elif body.kind == "anthropic":
            lst = await proxy_admin.list_claude_key()
            existing = next((p for p in lst if p.get("base-url") == body.base_url), None)
            key = body.api_key or (existing.get("api-key") if existing else "")
            entry = {"api-key": key or "", "base-url": body.base_url,
                     "models": models or (existing.get("models") if existing else []) or []}
            lst = [p for p in lst if p.get("base-url") != body.base_url] + [entry]
            await proxy_admin.put_claude_key(lst)
        else:
            raise HTTPException(status_code=400, detail={"message": f"unknown kind '{body.kind}'"})
    except ManagementUnavailable as e:
        raise HTTPException(status_code=503, detail={"message": str(e)})
    except ManagementError as e:
        raise HTTPException(status_code=502, detail={"message": str(e)})
    return {"ok": True}


@router.delete("/api/providers/custom")
@router.delete("/api/providers/custom/")
async def delete_custom(kind: str, id: str):
    try:
        if kind == "openai":
            lst = [p for p in await proxy_admin.list_openai_compat() if p.get("name") != id]
            await proxy_admin.put_openai_compat(lst)
        elif kind == "anthropic":
            lst = [p for p in await proxy_admin.list_claude_key() if p.get("base-url") != id]
            await proxy_admin.put_claude_key(lst)
        else:
            raise HTTPException(status_code=400, detail={"message": f"unknown kind '{kind}'"})
    except ManagementUnavailable as e:
        raise HTTPException(status_code=503, detail={"message": str(e)})
    except ManagementError as e:
        raise HTTPException(status_code=502, detail={"message": str(e)})
    return {"ok": True}


@router.get("/api/providers/health")
async def providers_health():
    try:
        models = await lm.list_models()
        online = True
    except Exception:  # noqa: BLE001
        models, online = [], False
    mgmt = await proxy_admin.management_status()
    return {"proxy_online": online, "model_count": len(models), "management": mgmt}


@router.get("/api/providers/models")
async def providers_models():
    try:
        return {"models": await lm.list_models()}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail={"message": f"proxy model list failed: {e}"})

"""Prompt-editor routes (⇄ TS routes/prompts.ts).

Mirrors the TS contract exactly so the existing frontend prompt editor works unchanged
against the Python backend:

    GET    /api/prompts/tool-catalog
    GET    /api/prompts/            → list
    GET    /api/prompts/{name}
    PUT    /api/prompts/{name}            body {content}
    PUT    /api/prompts/{name}/config     body {model?, tools?}
    POST   /api/prompts/{name}/reset

There are no `.md` files here — a "prompt" is a DSPy Signature's instructions, named via
llm/prompts.REGISTRY. PUT/reset operate on the runtime override store (db); reset drops the
override → the signature's shipped default is restored. `{name}` is validated against the
registry (unknown → 404), and `name` may contain a `/` (e.g. "discovery/seed_perspectives"),
so the route uses a path converter.
"""
import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..db import reads, writers
from ..llm import prompts as registry

router = APIRouter()

# server-py's tool surface (⇄ TS TOOL_CATALOG, extended with the Python tiers). These are the
# retrieval/research tools the grounded DSPy modules can use; they describe the engine's
# capabilities for the editor's tool picker.
TOOL_CATALOG = [
    {"name": "web_search", "description": "Search the web for current information using targeted queries (SearXNG).", "category": "research"},
    {"name": "http_fetch", "description": "Fetch and read the full text content of a web page.", "category": "research"},
    {"name": "deep_lookup", "description": "Grounded single-question lookup: search, fetch top sources, and answer with citations.", "category": "research"},
    {"name": "deep_search", "description": "Multi-angle grounded research that synthesizes a cited briefing across several investigative angles.", "category": "research"},
]


class ContentBody(BaseModel):
    content: str


class ConfigBody(BaseModel):
    model: str | None = None
    tools: list[str] | None = None


def _prompt_view(name: str) -> dict:
    """The full prompt object the frontend expects (⇄ TS readPrompt): name, path, content,
    agent, variables, stage, model, tools, task_profile (+ overridden flag for parity)."""
    content = registry.get_instructions(name)
    config = reads.get_prompt_config(name)
    stage = name.split("/", 1)[0] if "/" in name else "root"
    slug = name.split("/", 1)[1] if "/" in name else name
    return {
        "name": name,
        "path": f"{name}.md",
        "content": content,
        "agent": f"{stage}:{slug}",
        "variables": registry.variables(content),
        "stage": stage,
        "model": config["model"],
        "tools": config["tools"],
        "task_profile": registry.TASK_PROFILE.get(name),
        "overridden": reads.get_prompt_instructions(name) is not None,
    }


@router.get("/api/prompts/tool-catalog")
async def tool_catalog():
    return TOOL_CATALOG


@router.get("/api/prompts")
@router.get("/api/prompts/")
async def list_prompts():
    return [_prompt_view(name) for name in registry.names()]


@router.get("/api/prompts/{name:path}")
async def get_prompt(name: str):
    if not registry.is_registered(name):
        raise HTTPException(status_code=404, detail={"error": "Prompt not found"})
    return _prompt_view(name)


@router.put("/api/prompts/{name:path}/config")
async def put_config(name: str, body: ConfigBody):
    if not registry.is_registered(name):
        raise HTTPException(status_code=404, detail={"error": "Prompt not found"})
    config = await asyncio.to_thread(writers.set_prompt_config, name, body.model, body.tools)
    return {"name": name, **config}


@router.post("/api/prompts/{name:path}/reset")
async def reset_prompt(name: str):
    if not registry.is_registered(name):
        raise HTTPException(status_code=404, detail={"error": "Prompt not found"})
    await asyncio.to_thread(writers.clear_prompt_instructions, name)
    return _prompt_view(name)


@router.put("/api/prompts/{name:path}")
async def put_prompt(name: str, body: ContentBody):
    if not registry.is_registered(name):
        raise HTTPException(status_code=404, detail={"error": "Prompt not found"})
    await asyncio.to_thread(writers.set_prompt_instructions, name, body.content)
    return _prompt_view(name)

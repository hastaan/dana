"""Internet-lookup route — the unified three-tier research facade over HTTP.

POST /api/research/lookup  { query, level, ...params }  → { status, level, answer|content, sources[] }
Lets the frontend (and any caller) run quick / deep_lookup / deep_search with explicit args,
with graceful tier fallback. Heavy tiers run off the event loop.

GET /api/research/lookup/stream?query=&level=&breadth=  → text/event-stream
Runs the heavy tier in a worker thread, streaming its emit() think/progress events live as
unnamed SSE `data:` frames, then exactly one final {"type":"result","result": <LookupResponse>}.
"""
import asyncio
import json

from fastapi import APIRouter, Request
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from ..research.deep_search import deep_search
from ..research.internet import deep_lookup, internet_lookup

router = APIRouter()

# Sentinel pushed onto the queue when the worker thread finishes, so the drain loop knows to stop.
_DONE = object()


class LookupBody(BaseModel):
    query: str
    level: str = "deep_lookup"          # quick | deep_lookup | deep_search
    # pass-through knobs (only those relevant to the chosen level are used)
    top_k: int | None = None
    fetch_top: int | None = None
    max_sub_questions: int | None = None
    breadth: str | None = None          # deep_search: clue | topic | article
    max_personas: int | None = None
    max_turns: int | None = None
    persona: str | None = None
    language: str | None = None
    topic_id: str | None = None


@router.post("/api/research/lookup")
async def research_lookup(body: LookupBody):
    params = {k: v for k, v in body.model_dump().items()
              if k not in ("query", "level") and v is not None}
    return await internet_lookup(body.query, level=body.level, **params)


# Knobs each heavy tier accepts (mirrors the filtering in internet_lookup), so query-string
# params that don't apply to the chosen tier are silently ignored rather than erroring.
_DEEP_LOOKUP_KEYS = frozenset({"topic", "topic_id", "top_k", "fetch_top", "max_sub_questions", "persona"})
_DEEP_SEARCH_KEYS = frozenset({"topic_id", "breadth", "max_personas", "max_turns", "top_k"})


@router.get("/api/research/lookup/stream")
async def research_lookup_stream(request: Request, query: str, level: str = "deep_lookup"):
    """SSE: run a heavy tier (deep_lookup | deep_search) off the loop, streaming its emit()
    events live, then one final {"type":"result","result": <full LookupResponse>}.

    `quick` does NOT stream (no live trace to show); this route only supports the heavy tiers,
    falling back to deep_lookup for any unrecognized level. The result object is byte-identical
    to POST /api/research/lookup, so the frontend renders it the same way."""
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    # emit() runs inside the worker thread → hop back onto the loop to touch the asyncio.Queue
    # (same thread-safety discipline as events/bus.py).
    def emit(event: dict) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, event)

    # Coerce numeric query params (EventSource sends strings); ignore anything malformed.
    def _int(name: str) -> int | None:
        raw = request.query_params.get(name)
        try:
            return int(raw) if raw is not None else None
        except (TypeError, ValueError):
            return None

    params: dict = {"emit": emit}
    if (breadth := request.query_params.get("breadth")):
        params["breadth"] = breadth
    if (topic_id := request.query_params.get("topic_id")):
        params["topic_id"] = topic_id
    if (persona := request.query_params.get("persona")):
        params["persona"] = persona
    for name in ("top_k", "fetch_top", "max_sub_questions", "max_personas", "max_turns"):
        if (val := _int(name)) is not None:
            params[name] = val

    def run() -> dict:
        try:
            if level == "deep_search":
                return deep_search(query, **{k: v for k, v in params.items()
                                             if k in _DEEP_SEARCH_KEYS or k == "emit"})
            # default / "deep_lookup" / anything unrecognized → deep_lookup
            return deep_lookup(query, **{k: v for k, v in params.items()
                                         if k in _DEEP_LOOKUP_KEYS or k == "emit"})
        except Exception as e:  # noqa: BLE001 — surface as an error result, never crash the stream
            return {"status": "error", "level": level, "query": query, "message": str(e),
                    "results": [], "sources": []}

    async def event_generator():
        # Kick off the heavy tier; when it returns, push the result + a DONE sentinel so the
        # drain loop emits the final frame and stops.
        async def worker():
            result = await asyncio.to_thread(run)
            queue.put_nowait({"type": "result", "result": result})
            queue.put_nowait(_DONE)

        task = asyncio.create_task(worker())
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    # Bounded wait so we emit a keepalive ping and re-check disconnection during
                    # a long deep_search (a bare get() would block past proxy idle timeouts).
                    event = await asyncio.wait_for(queue.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    yield {"data": json.dumps({"type": "ping"})}
                    continue
                if event is _DONE:
                    break
                yield {"data": json.dumps(event)}
        finally:
            task.cancel()

    return EventSourceResponse(event_generator())

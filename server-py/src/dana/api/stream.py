"""SSE endpoint (⇄ TS routes/stream.ts): GET /api/topics/:id/stream.

The React frontend uses a bare EventSource with `onmessage` (unnamed events) and
parses `JSON.parse(e.data)`, so we emit `data: {json}\n\n` with no event name, plus a
15s keep-alive ping — byte-compatible with the TS contract.
"""
import asyncio
import json

from fastapi import APIRouter, Request
from sse_starlette.sse import EventSourceResponse

from ..events.bus import bus

router = APIRouter()

PING_INTERVAL = 15.0


@router.get("/api/topics/{topic_id}/stream")
async def stream(topic_id: str, request: Request):
    queue = bus.subscribe(topic_id)

    async def event_generator():
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=PING_INTERVAL)
                    yield {"data": json.dumps(event)}
                except asyncio.TimeoutError:
                    yield {"data": json.dumps({"type": "ping"})}
        finally:
            bus.unsubscribe(topic_id, queue)

    return EventSourceResponse(event_generator())

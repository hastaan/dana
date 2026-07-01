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
    # Snapshot the recent-event window BEFORE subscribing, so an op whose events fired in the
    # sub-second gap before this EventSource connected still reaches the client. Subscribe right
    # after: any event emitted between the snapshot and subscribe carries a higher `_seq` and is
    # delivered live; the client dedupes by `_seq` so the overlap never double-renders.
    backlog = bus.recent(topic_id)
    queue = bus.subscribe(topic_id)

    async def event_generator():
        try:
            for event in backlog:
                yield {"data": json.dumps(event)}
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

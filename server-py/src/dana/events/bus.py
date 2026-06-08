"""Per-topic SSE pub/sub (⇄ TS routes/stream.ts in-memory Map).

Review-driven design choices:
- **Thread-safe emit**: agents (and DSPy callbacks) may run in worker threads
  (asyncio.to_thread) — so emit() schedules delivery onto the event loop via
  call_soon_threadsafe rather than touching the asyncio.Queue from another thread.
- **No drop-on-full**: lifecycle events (forum_turn, stage_complete, verdict_content,
  clue_discovered) must never be silently dropped, so subscriber queues are unbounded.
  A slow/abandoned client is reaped when its connection drops (stream.py).
"""
import asyncio
from collections import defaultdict


class TopicBus:
    def __init__(self) -> None:
        self._subs: dict[str, set[asyncio.Queue]] = defaultdict(set)
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self, topic_id: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self._subs[topic_id].add(q)
        return q

    def unsubscribe(self, topic_id: str, q: asyncio.Queue) -> None:
        subs = self._subs.get(topic_id)
        if subs:
            subs.discard(q)
            if not subs:
                self._subs.pop(topic_id, None)

    def emit(self, topic_id: str, event: dict) -> None:
        """Publish an SSE event. Safe to call from any thread."""
        loop = self._loop
        if loop is not None and loop.is_running():
            loop.call_soon_threadsafe(self._deliver, topic_id, event)
        else:
            self._deliver(topic_id, event)

    def _deliver(self, topic_id: str, event: dict) -> None:
        for q in list(self._subs.get(topic_id, ())):
            q.put_nowait(event)


bus = TopicBus()

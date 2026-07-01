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
import time
from collections import defaultdict, deque

# How long a just-emitted event stays replayable to a freshly-connected subscriber. Sized to
# cover the EventSource connect latency (React render → GET /stream → subscribe), which is the
# window during which a synchronous op (smart-edit/add, party smart-add/edit) would otherwise
# emit its research events to nobody. Short enough that opening a topic doesn't dump an old run.
REPLAY_WINDOW = 12.0
_RECENT_MAX = 256


class TopicBus:
    def __init__(self) -> None:
        self._subs: dict[str, set[asyncio.Queue]] = defaultdict(set)
        self._loop: asyncio.AbstractEventLoop | None = None
        # Per-topic ring buffer of (monotonic_ts, event) for connect-race replay.
        self._recent: dict[str, deque] = defaultdict(lambda: deque(maxlen=_RECENT_MAX))
        self._seq = 0  # monotonic event id; lets the client dedupe replayed-vs-live events

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

    def recent(self, topic_id: str, window: float = REPLAY_WINDOW) -> list[dict]:
        """Events emitted within `window` seconds, oldest-first — replayed to a new subscriber so
        a sub-second-late connect still sees an op's early activity. Each carries `_seq` so the
        client drops any that also arrive live (no duplicates on the feed↔modal handoff)."""
        now = time.monotonic()
        return [ev for (ts, ev) in list(self._recent.get(topic_id, ())) if now - ts <= window]

    def emit(self, topic_id: str, event: dict) -> None:
        """Publish an SSE event. Safe to call from any thread."""
        loop = self._loop
        if loop is not None and loop.is_running():
            loop.call_soon_threadsafe(self._deliver, topic_id, event)
        else:
            self._deliver(topic_id, event)

    def _deliver(self, topic_id: str, event: dict) -> None:
        # Runs on the loop thread (call_soon_threadsafe) or inline when no loop — single-threaded
        # either way, so the seq counter + ring buffer need no lock. Stamp a copy so the caller's
        # dict is never mutated; subscribers and the buffer share the one stamped copy.
        self._seq += 1
        stamped = {**event, "_seq": self._seq}
        self._recent[topic_id].append((time.monotonic(), stamped))
        for q in list(self._subs.get(topic_id, ())):
            q.put_nowait(stamped)


bus = TopicBus()

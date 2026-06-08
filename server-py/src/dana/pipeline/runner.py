"""Run registry (⇄ TS routes/pipeline.ts activeRuns).

One run per topic (409 on conflict). Background asyncio task; the registry entry is
cleared on completion or failure. Note (review): this is in-memory, so runs are orphaned
on process restart — Phase 2 adds DB-backed run state + checkpoint resume.
"""
import asyncio
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone

from ..events.bus import bus


class RunRegistry:
    def __init__(self) -> None:
        self._runs: dict[str, dict] = {}
        self._lock = asyncio.Lock()

    def active(self, topic_id: str) -> dict | None:
        return self._runs.get(topic_id)

    async def start(self, topic_id: str, run_id: str, work: Callable[[], Awaitable[None]]) -> dict | None:
        async with self._lock:
            if topic_id in self._runs:
                return None
            entry = {"run_id": run_id, "started_at": datetime.now(timezone.utc).isoformat()}
            self._runs[topic_id] = entry

        async def _wrap() -> None:
            try:
                await work()
            except Exception as e:  # noqa: BLE001
                bus.emit(topic_id, {"type": "error", "message": str(e)})
            finally:
                self._runs.pop(topic_id, None)

        asyncio.create_task(_wrap())
        return {**entry, "status": "started"}


registry = RunRegistry()

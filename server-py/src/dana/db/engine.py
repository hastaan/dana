"""Async SQLAlchemy engine over the existing dana.db schema.

For Phase 0 we use targeted SQL (text()) against the schema defined in the TS
backend's db/database.ts; the full ORM mapping (db/models.py) lands in Phase 2.
Writes go through a single async lock (see write_lock) — SQLite is single-writer,
and during the migration window we must not contend with the TS backend on the
live file (dev uses a copy; see config.Settings.data_dir).
"""
import asyncio

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from ..config import settings

_engine: AsyncEngine | None = None
write_lock = asyncio.Lock()


def get_engine() -> AsyncEngine:
    global _engine
    if _engine is None:
        _engine = create_async_engine(
            f"sqlite+aiosqlite:///{settings.db_path}",
            echo=False,
            pool_pre_ping=True,
        )

        @event.listens_for(_engine.sync_engine, "connect")
        def _set_pragmas(dbapi_conn, _record):  # noqa: ANN001
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA foreign_keys=ON")
            cur.execute("PRAGMA synchronous=NORMAL")
            cur.execute("PRAGMA busy_timeout=5000")
            cur.close()

    return _engine


async def dispose_engine() -> None:
    global _engine
    if _engine is not None:
        await _engine.dispose()
        _engine = None

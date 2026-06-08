"""Synchronous SQLite access for the pipeline engine (which runs in a worker thread).

The async SQLAlchemy engine (engine.py) serves the API read paths; the long-running
DSPy pipeline writes through plain sqlite3 here — simpler and natural off-loop. Same
WAL file, busy_timeout guards concurrent access.
"""
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager

from ..config import settings


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(str(settings.db_path), timeout=10.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

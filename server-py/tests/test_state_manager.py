"""Unit tests for pipeline/state_manager.py — version allocation, stage marking, finalize, and
the clue-version delta. Uses a temp sqlite DB (no network/LLM); patches the sync connect() path.
"""
import json
import sqlite3

import pytest

from dana.db import sync_db, writers
from dana.pipeline import state_manager as sm

_SCHEMA = """
CREATE TABLE topics (id TEXT PRIMARY KEY, title TEXT, description TEXT, status TEXT,
  current_version INTEGER, models TEXT, settings TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE clues (id TEXT, topic_id TEXT, current_version INTEGER, status TEXT, added_by TEXT,
  added_at TEXT, last_updated_at TEXT, PRIMARY KEY(id,topic_id));
CREATE TABLE clue_versions (clue_id TEXT, topic_id TEXT, version INTEGER, date TEXT, title TEXT,
  raw_source TEXT, source_credibility TEXT, bias_corrected_summary TEXT, relevance_score INTEGER,
  party_relevance TEXT, domain_tags TEXT, timeline_date TEXT, clue_type TEXT, change_note TEXT,
  key_points TEXT, fact_check TEXT, PRIMARY KEY(clue_id,topic_id,version));
CREATE TABLE parties (id TEXT, topic_id TEXT, name TEXT, type TEXT, description TEXT, weight REAL,
  weight_factors TEXT, weight_evidence TEXT, agenda TEXT, means TEXT, circle TEXT, stance TEXT,
  vulnerabilities TEXT, auto_discovered INT, user_verified INT, PRIMARY KEY(id,topic_id));
CREATE TABLE representatives (id TEXT, topic_id TEXT, party_id TEXT, persona_title TEXT,
  persona_prompt TEXT, speaking_weight REAL, speaking_budget TEXT, auto_generated INT);
CREATE TABLE states (id INTEGER PRIMARY KEY AUTOINCREMENT, topic_id TEXT, version INTEGER,
  label TEXT, created_at TEXT, trigger TEXT, clue_snapshot TEXT, forum_session_id TEXT,
  verdict_id TEXT, delta_from INTEGER, delta_summary TEXT, parent_version INTEGER, fork_stage TEXT,
  version_status TEXT DEFAULT 'complete', parties_snapshot TEXT, representatives_snapshot TEXT,
  completed_stages TEXT DEFAULT '[]');
CREATE UNIQUE INDEX idx_states_topic_version ON states(topic_id, version);
"""


@pytest.fixture()
def db(tmp_path, monkeypatch):
    path = tmp_path / "dana.db"
    conn = sqlite3.connect(str(path))
    conn.executescript(_SCHEMA)
    conn.execute("INSERT INTO topics VALUES ('t1','T','D','draft',0,'{}','{}','now','now')")
    conn.execute("INSERT INTO clues VALUES ('clue-001','t1',1,'verified','auto','now','now')")
    conn.execute(
        "INSERT INTO clue_versions (clue_id,topic_id,version,title,party_relevance,relevance_score,"
        "timeline_date) VALUES ('clue-001','t1',1,'C1','[\"p1\"]',80,'2026-01-01')")
    conn.execute(
        "INSERT INTO parties VALUES ('p1','t1','P1','state','',10,'{}','{}','','[]','{}','active','[]',1,0)")
    conn.commit()
    conn.close()

    # Point the sync connect() at the temp DB (writers + state_manager both use sync_db.connect).
    from contextlib import contextmanager

    @contextmanager
    def _connect():
        c = sqlite3.connect(str(path))
        c.row_factory = sqlite3.Row
        try:
            yield c
            c.commit()
        finally:
            c.close()

    monkeypatch.setattr(sync_db, "connect", _connect)
    monkeypatch.setattr(writers, "connect", _connect)
    return path


def test_first_run_reuses_one_version(db):
    v = sm.get_or_allocate_version("t1", fork_stage="discovery")
    assert v == 1
    # Sequential stages reuse the same in-progress version.
    for stage in ("enrichment", "forum_prep", "forum", "expert_council"):
        assert sm.get_or_allocate_version("t1", fork_stage=stage) == 1


def test_mark_stage_snapshots(db):
    v = sm.get_or_allocate_version("t1", fork_stage="discovery")
    sm.mark_stage_complete("t1", v, "discovery")
    st = writers.get_state("t1", v)
    assert st["completed_stages"] == ["discovery"]
    # discovery snapshots parties
    assert json.loads(st["parties_snapshot"])[0]["id"] == "p1"
    assert st["version_status"] == "in_progress"


def test_finalize_marks_complete(db):
    v = sm.get_or_allocate_version("t1", fork_stage="discovery")
    for stage in ("discovery", "enrichment", "forum_prep", "forum"):
        sm.mark_stage_complete("t1", v, stage)
    sm.finalize_version("t1", v, forum_session_id="forum-session-v1", verdict_id="verdict-v1")
    st = writers.get_state("t1", v)
    assert st["version_status"] == "complete"
    assert st["verdict_id"] == "verdict-v1"
    assert st["forum_session_id"] == "forum-session-v1"


def test_compute_delta_detects_new_clue(db):
    v = sm.get_or_allocate_version("t1", fork_stage="discovery")
    for stage in ("discovery", "enrichment", "forum_prep", "forum"):
        sm.mark_stage_complete("t1", v, stage)
    sm.finalize_version("t1", v)
    # No change yet.
    assert sm.compute_delta("t1") is None
    # Add a clue → delta detects it and the affected party.
    writers.add_clue("t1", {"id": "clue-002", "title": "C2", "party_relevance": ["p1", "p2"], "relevance": 70})
    delta = sm.compute_delta("t1")
    assert delta is not None
    assert delta["new_clues"] == ["clue-002"]
    assert set(delta["affected_parties"]) == {"p1", "p2"}


def test_fork_from_complete_version(db):
    v = sm.get_or_allocate_version("t1", fork_stage="discovery")
    for stage in ("discovery", "enrichment", "forum_prep", "forum"):
        sm.mark_stage_complete("t1", v, stage)
    sm.finalize_version("t1", v, forum_session_id="forum-session-v1")
    # Latest is complete → a new run forks v2, inheriting stages before the fork point.
    # Forking AT expert_council inherits every prior stage and carries the forum session forward.
    v2 = sm.get_or_allocate_version("t1", fork_stage="expert_council")
    assert v2 == 2
    st2 = writers.get_state("t1", v2)
    assert st2["parent_version"] == 1
    assert st2["version_status"] == "in_progress"
    assert st2["completed_stages"] == ["discovery", "enrichment", "forum_prep", "forum"]
    assert st2["forum_session_id"] == "forum-session-v1"

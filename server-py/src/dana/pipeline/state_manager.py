"""Version/state manager (⇄ TS pipeline/stateManager.ts).

Tracks the topic's analysis VERSIONS in the `states` table: each run reuses an in-progress
version or forks a new one from the latest complete version, marks stages complete (snapshotting
parties/clues/reps as it goes), and finalizes on scoring. This is what powers the version
selector, the staleness banner's clue-delta, and historical `?version=` snapshot reads.

All functions are SYNC (the pipeline runs in a worker thread and writes through sqlite3); they
mirror the TS async signatures minus the await. STAGE_ORDER + the fork/inherit/snapshot rules
are ported field-for-field so the shared `states` rows stay byte-compatible with any the TS
backend wrote.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

from ..db import writers

STAGE_ORDER = ["discovery", "enrichment", "forum_prep", "forum", "expert_council"]
_STAGES_AFTER_FORUM = ("expert_council", "scoring")


def _iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_or_allocate_version(topic_id: str, *, fork_stage: str | None,
                            trigger: str | None = None) -> int:
    """Reuse the current in-progress version, else fork a new one from the latest complete
    version (⇄ getOrAllocateVersion). For a sequential first run this keeps reusing v1."""
    latest = writers.get_latest_state(topic_id)
    if latest and latest["version_status"] == "in_progress":
        return latest["version"]
    fork_from = latest["version"] if latest and latest["version_status"] == "complete" else None
    return allocate_version(topic_id, fork_from=fork_from, fork_stage=fork_stage, trigger=trigger)


def allocate_version(topic_id: str, *, fork_from: int | None, fork_stage: str | None,
                     label: str | None = None, trigger: str | None = None) -> int:
    """Allocate a NEW version row upfront (⇄ allocateVersion). Snapshots current parties/reps,
    inherits a parent's completed_stages truncated to before the fork point, and only carries a
    parent forum_session forward when forking at/after the forum stage."""
    states = writers.get_all_states(topic_id)
    version = (max(s["version"] for s in states) + 1) if states else 1
    clue_snapshot = writers.get_current_clue_snapshot(topic_id)
    parties_snapshot = json.dumps(writers.list_parties_sync(topic_id))
    representatives_snapshot = json.dumps(writers.list_representatives_sync(topic_id))

    parent_session_id = None
    inherited_stages: list[str] = []
    if fork_from and fork_stage:
        parent = writers.get_state(topic_id, fork_from)
        if parent:
            if fork_stage in _STAGES_AFTER_FORUM:
                parent_session_id = parent["forum_session_id"]
            fork_index = STAGE_ORDER.index(fork_stage) if fork_stage in STAGE_ORDER else -1
            if fork_index >= 0:
                inherited_stages = [s for s in parent["completed_stages"]
                                    if s in STAGE_ORDER and STAGE_ORDER.index(s) < fork_index]

    state = {
        "version": version,
        "label": label or (f"Re-run from {fork_stage} (v{version})" if fork_from else f"Analysis v{version}"),
        "created_at": _iso(),
        "trigger": trigger or ("user_manual" if fork_from else "initial_run"),
        "clue_snapshot": clue_snapshot,
        "forum_session_id": parent_session_id,
        "verdict_id": None,
        "delta_from": fork_from,
        "delta_summary": None,
        "parent_version": fork_from,
        "fork_stage": fork_stage,
        "version_status": "in_progress",
        "parties_snapshot": parties_snapshot,
        "representatives_snapshot": representatives_snapshot,
        "completed_stages": inherited_stages,
    }
    writers.insert_state(topic_id, state)
    writers.update_topic(topic_id, {"current_version": version})
    return version


def mark_stage_complete(topic_id: str, version: int, stage: str) -> None:
    """Append `stage` to the version's completed_stages + snapshot the artifact that stage
    produced (⇄ markStageComplete): discovery→parties, enrichment→clues, forum_prep→reps."""
    state = writers.get_state(topic_id, version)
    if not state:
        return
    stages = list(state["completed_stages"])
    if stage not in stages:
        stages.append(stage)
    snapshots: dict = {}
    if stage == "discovery":
        snapshots["parties_snapshot"] = json.dumps(writers.list_parties_sync(topic_id))
    elif stage == "enrichment":
        snapshots["clue_snapshot"] = writers.get_current_clue_snapshot(topic_id)
    elif stage == "forum_prep":
        snapshots["representatives_snapshot"] = json.dumps(writers.list_representatives_sync(topic_id))
    writers.update_completed_stages(topic_id, version, stages, snapshots)


def set_version_session_id(topic_id: str, version: int, session_id: str) -> None:
    writers.update_version_field(topic_id, version, "forum_session_id", session_id)


def finalize_version(topic_id: str, version: int, *, forum_session_id: str | None = None,
                     verdict_id: str | None = None) -> None:
    """Mark a version complete with final clue/parties/reps snapshots + set topic complete
    (⇄ finalizeVersion)."""
    writers.finalize_version(topic_id, version, {
        "verdict_id": verdict_id,
        "forum_session_id": forum_session_id,
        "clue_snapshot": writers.get_current_clue_snapshot(topic_id),
        "parties_snapshot": json.dumps(writers.list_parties_sync(topic_id)),
        "representatives_snapshot": json.dumps(writers.list_representatives_sync(topic_id)),
    })
    writers.update_topic(topic_id, {"current_version": version, "status": "complete"})


def compute_delta(topic_id: str) -> dict | None:
    """Diff the current clue snapshot against the latest COMPLETE version's snapshot (⇄
    computeDelta). Returns {new_clues, updated_clues, affected_parties, key_change} or None when
    there's no prior complete version or nothing changed."""
    latest = writers.get_latest_complete_state(topic_id)
    if not latest:
        return None
    prev = latest["clue_snapshot"] or {"ids_and_versions": {}}
    prev_iv = prev.get("ids_and_versions", {})
    current = writers.get_current_clue_snapshot(topic_id)

    new_clues: list[str] = []
    updated_clues: list[str] = []
    for cid, ver in current["ids_and_versions"].items():
        if cid not in prev_iv:
            new_clues.append(cid)
        elif prev_iv[cid] != ver:
            updated_clues.append(cid)

    if not new_clues and not updated_clues:
        return None

    affected: list[str] = []
    clues = {c["id"]: c for c in writers.clue_index(topic_id)}
    for cid in new_clues + updated_clues:
        c = clues.get(cid)
        if not c:
            continue
        for p in c.get("party_relevance", []):
            if p not in affected:
                affected.append(p)

    return {
        "new_clues": new_clues,
        "updated_clues": updated_clues,
        "affected_parties": affected,
        "key_change": f"{len(new_clues)} new clue(s), {len(updated_clues)} updated clue(s)",
    }


def create_version(topic_id: str, *, label: str, trigger: str,
                   forum_session_id: str | None = None, verdict_id: str | None = None,
                   delta_from: int | None = None, delta_summary: dict | None = None) -> dict:
    """Allocate + finalize a COMPLETE version in one shot (⇄ createVersion). Used by the delta
    pipeline, which builds its forum/verdict before recording the version."""
    states = writers.get_all_states(topic_id)
    version = (max(s["version"] for s in states) + 1) if states else 1
    state = {
        "version": version, "label": label, "created_at": _iso(), "trigger": trigger,
        "clue_snapshot": writers.get_current_clue_snapshot(topic_id),
        "forum_session_id": forum_session_id, "verdict_id": verdict_id,
        "delta_from": delta_from, "delta_summary": delta_summary,
        "parent_version": delta_from, "fork_stage": None, "version_status": "complete",
        "parties_snapshot": json.dumps(writers.list_parties_sync(topic_id)),
        "representatives_snapshot": json.dumps(writers.list_representatives_sync(topic_id)),
        "completed_stages": list(STAGE_ORDER),
    }
    writers.insert_state(topic_id, state)
    writers.update_topic(topic_id, {"current_version": version, "status": "complete"})
    return state

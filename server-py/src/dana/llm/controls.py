"""Analysis controls (⇄ frontend Settings.tsx CONTROLS_DEFAULTS / TS analysisControls).

The operator-tunable knobs that bound how much research/iteration each operation does.
Stored in app_settings.analysis_controls (a flat {key: number} dict); read sync from a
worker thread via db.reads.get_analysis_controls(). Anything unset falls back to the
shipped DEFAULTS here, so behavior is identical to before this module existed.

Only the controls the Python backend actually consumes are honored; the rest exist for
contract parity with the frontend editor (which writes the full set).
"""
from __future__ import annotations

from ..db import reads

# Mirror frontend CONTROLS_DEFAULTS (the subset server-py reads is documented per-key).
DEFAULTS: dict[str, int] = {
    "discovery_research_iterations": 5,
    "scoring_iterations": 3,
    "enrichment_iterations": 8,
    "fact_check_iterations": 3,
    "research_search_queries": 4,    # smart_extract_research: # of search queries
    "smart_edit_queries": 3,         # smart edit/add/merge/split + clue smart-edit: # queries
    "smart_edit_max_chars": 15000,   # max chars of gathered research sent to the LLM
    "bulk_import_iterations": 5,
    "bulk_import_chunk_max_chars": 4000,
    "bulk_fact_check_iterations": 2,
    "evidence_update_iterations": 3,
    "cleanup_fact_check_iterations": 2,
    "default_max_iterations": 5,
}


def get_controls() -> dict[str, int]:
    """The effective controls: DEFAULTS overlaid with any stored analysis_controls. Sync;
    safe from a worker thread. Non-numeric stored values are ignored (fall back to default)."""
    stored = reads.get_analysis_controls()
    out = dict(DEFAULTS)
    for k, v in (stored or {}).items():
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            out[k] = int(v)
    return out


def control(name: str, default: int | None = None) -> int:
    """One control value (stored override else shipped default else `default`)."""
    c = get_controls()
    if name in c:
        return c[name]
    if default is not None:
        return default
    return DEFAULTS.get(name, 0)

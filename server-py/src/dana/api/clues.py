"""Clue-management router (⇄ deleted TS routes/clues.ts). Supersedes the two stub clue endpoints
that lived in topics.py (GET list + DELETE) — adds version handling on GET and the missing
markStale on DELETE — and implements every other frontend clue path: manual add, PUT edit,
smart-edit, research-extract, bulk import, update-all, and cleanup propose/apply.

The fire-and-forget ops (bulk / update-all / cleanup) use module-level per-topic job dicts updated
by asyncio background tasks (⇄ the TS in-memory Maps); the POST kicks one off and returns
{status}, the GET /status reads it. All LLM/search work is bounded (see agents/clue_intel.py) and
runs in asyncio.to_thread under dspy_lm.lm_context(). SSE uses ONLY the UI-rendered types:
think{icon,label,detail}, clue_discovered{clue_id,title,source,relevance}, and stage_complete with
stage in {bulk_import, evidence_update, cleanup}.
"""
import asyncio
import json
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..agents import clue_intel
from ..db import reads, writers
from ..db import topics as topics_repo
from ..db.reads import list_clues_api
from ..events.bus import bus
from ..llm import dspy_lm

router = APIRouter()

# ── Per-topic job state for the fire-and-forget ops (⇄ TS Maps) ─────────────────────
_bulk_jobs: dict[str, dict] = {}     # {status, stored, updated, skipped, error?}
_update_jobs: dict[str, dict] = {}   # {status, checked, updated, error?}
_cleanup_jobs: dict[str, dict] = {}  # {status, groups, original_count, error?}

# Bound LLM concurrency in the background runners (chunks / clues processed in parallel).
_BULK_CONCURRENCY = 3
_UPDATE_CONCURRENCY = 3
_SWEEP_CONCURRENCY = 3


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


async def _require_topic(topic_id: str) -> dict:
    topic = await topics_repo.get_topic(topic_id)
    if topic is None:
        raise HTTPException(status_code=404, detail={"message": "Topic not found"})
    return topic


def _think(topic_id: str, icon: str, label: str, detail: str = "") -> None:
    bus.emit(topic_id, {"type": "think", "icon": icon, "label": label, "detail": detail})


def _verdict_icon(verdict: str) -> str:
    return "✅" if verdict == "verified" else "🔶" if verdict == "disputed" else "⚠️"


_STATUS_MAP = {"verified": "verified", "disputed": "disputed",
               "misleading": "disputed", "unverifiable": "pending"}


def _apply_fact_check(topic_id: str, clue_id: str, cur: dict, verdict) -> None:
    """Write a FactVerdict to the clue's current version + status (⇄ FactCheckAgent DB write +
    statusMap). Sync; call in a worker thread."""
    fc = {
        "verdict": verdict.verdict, "bias_analysis": verdict.bias_analysis,
        "counter_evidence": verdict.counter_evidence, "cui_bono": verdict.cui_bono,
        "adjusted_credibility": verdict.adjusted_credibility,
        "adjusted_bias_flags": verdict.adjusted_bias_flags, "checked_at": _now(),
    }
    writers.update_clue_version(topic_id, clue_id, {
        "fact_check": fc,
        "source_credibility": {**(cur.get("source_credibility") or {}),
                               "score": verdict.adjusted_credibility,
                               "bias_flags": verdict.adjusted_bias_flags},
    })
    writers.set_clue_status(topic_id, clue_id, _STATUS_MAP.get(verdict.verdict, "pending"))


# ── Request bodies (⇄ frontend api/client.ts clues.*) ───────────────────────────────
class ClueBody(BaseModel):
    model_config = {"extra": "allow"}  # manual add + PUT send Record<string, unknown>


class FeedbackBody(BaseModel):
    feedback: str = ""


class BulkBody(BaseModel):
    content: str = ""


class ResearchBody(BaseModel):
    query: str = ""


class CleanupApplyBody(BaseModel):
    groups: list[dict] = []


# ── Reads ───────────────────────────────────────────────────────────────────────────
@router.get("/api/topics/{topic_id}/clues")
async def get_clues(topic_id: str, version: int | None = None):
    """List clues in the frontend-nested shape. With ?version=, serve that version's pinned
    clue_snapshot for completed historical versions (⇄ TS dbGetCluesAtSnapshot): empty until
    enrichment completed, each clue pinned to its snapshot version. Without it, the live list."""
    if version is not None:
        return await reads.list_clues_api_at_version(topic_id, version)
    return await reads.list_clues_api(topic_id)


@router.get("/api/topics/{topic_id}/clues/{clue_id}")
async def get_clue(topic_id: str, clue_id: str):
    c = await asyncio.to_thread(writers.get_clue, topic_id, clue_id)
    if c is None:
        raise HTTPException(status_code=404, detail={"message": "Clue not found"})
    return c


# ── Manual add (parity — frontend doesn't call POST / directly) ──────────────────────
@router.post("/api/topics/{topic_id}/clues")
async def add_clue(topic_id: str, body: ClueBody):
    await _require_topic(topic_id)
    b = body.model_dump()
    try:
        cid = await asyncio.to_thread(writers.next_clue_id, topic_id)
        urls = b.get("source_urls") or ([b["source_url"]] if b.get("source_url") else [])
        clue = {
            "id": cid, "title": b.get("title", ""),
            "source_urls": urls, "source_outlets": b.get("source_outlets", []),
            "credibility": b.get("credibility_score", 50),
            "credibility_notes": b.get("credibility_notes", ""),
            "bias_flags": b.get("bias_flags", []),
            "summary": b.get("bias_corrected_summary", ""),
            "relevance": b.get("relevance_score", 50),
            "party_relevance": b.get("party_relevance", []),
            "domain_tags": b.get("domain_tags", []),
            "timeline_date": b.get("timeline_date") or _today(),
            "date": _now(), "clue_type": b.get("clue_type", "event"),
            "key_points": b.get("key_points", []),
            "change_note": "User-submitted initial version",
            "status": "verified", "added_by": "user",
        }
        await asyncio.to_thread(writers.add_clue, topic_id, clue)
        await asyncio.to_thread(writers.set_topic_status, topic_id, "stale")
        return await asyncio.to_thread(writers.get_clue, topic_id, cid)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail={"message": str(e)})


# ── Inline edit (PUT) ─────────────────────────────────────────────────────────────────
@router.put("/api/topics/{topic_id}/clues/{clue_id}")
async def update_clue(topic_id: str, clue_id: str, body: ClueBody):
    await _require_topic(topic_id)
    clue = await asyncio.to_thread(writers.get_clue, topic_id, clue_id)
    if clue is None:
        raise HTTPException(status_code=404, detail={"message": "Clue not found"})
    cur = next((v for v in clue["versions"] if v["v"] == clue["current"]), None) or {}
    b = body.model_dump()
    patch: dict = {}
    for key in ("title", "bias_corrected_summary", "relevance_score", "party_relevance",
                "domain_tags", "timeline_date", "clue_type"):
        if key in b:
            patch[key] = b[key]
    if "credibility_score" in b or "bias_flags" in b or "credibility_notes" in b:
        sc = dict(cur.get("source_credibility") or {})
        if "credibility_score" in b:
            sc["score"] = b["credibility_score"]
        if "bias_flags" in b:
            sc["bias_flags"] = b["bias_flags"]
        if "credibility_notes" in b:
            sc["notes"] = b["credibility_notes"]
        patch["source_credibility"] = sc
    await asyncio.to_thread(writers.update_clue_version, topic_id, clue_id, patch)
    return await asyncio.to_thread(writers.get_clue, topic_id, clue_id)


# ── Delete (FIX: adds markStale the topics.py stub lacked) ────────────────────────────
@router.delete("/api/topics/{topic_id}/clues/{clue_id}")
async def delete_clue(topic_id: str, clue_id: str):
    await asyncio.to_thread(writers.delete_clue, topic_id, clue_id)
    await asyncio.to_thread(writers.set_topic_status, topic_id, "stale")
    return {"success": True}


# ── Smart edit (feedback → bounded research → updated version) ─────────────────────────
@router.post("/api/topics/{topic_id}/clues/smart-edit/{clue_id}")
async def smart_edit_clue(topic_id: str, clue_id: str, body: FeedbackBody):
    topic = await _require_topic(topic_id)
    fb = body.feedback.strip()
    if not fb:
        raise HTTPException(status_code=400, detail={"message": "feedback is required"})
    clue = await asyncio.to_thread(writers.get_clue, topic_id, clue_id)
    if clue is None:
        raise HTTPException(status_code=404, detail={"message": "Clue not found"})
    cur = next((v for v in clue["versions"] if v["v"] == clue["current"]), None) or {}
    sc = cur.get("source_credibility") or {}
    raw_urls = (cur.get("raw_source") or {}).get("urls") or []
    origin = sc.get("origin_sources") or [{}]
    current_data = {
        "title": cur.get("title", ""), "summary": cur.get("bias_corrected_summary", ""),
        "credibility": sc.get("score", 50), "bias_flags": sc.get("bias_flags", []),
        "relevance": cur.get("relevance_score", 50), "parties": cur.get("party_relevance", []),
        "source_url": raw_urls[0] if raw_urls else "",
        "source_outlet": (origin[0] or {}).get("outlet", "") if origin else "",
        "date": cur.get("timeline_date", ""), "clue_type": cur.get("clue_type", "event"),
    }
    _think(topic_id, "📝", "Smart edit started", f'Editing "{current_data["title"]}" — {fb[:80]}')
    model = dspy_lm.model_for(topic_id, "extraction")

    def _work():
        with dspy_lm.lm_context(model):
            return clue_intel.smart_edit_clue(topic["title"], current_data, fb,
                                              topic_id=topic_id, emit=lambda e: bus.emit(topic_id, e))

    try:
        updated = await asyncio.to_thread(_work)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail={"message": f"Smart edit failed: {e}"})
    await asyncio.to_thread(writers.update_clue_version, topic_id, clue_id, {
        "title": updated.title, "bias_corrected_summary": updated.summary,
        "relevance_score": updated.relevance, "party_relevance": updated.parties,
        "timeline_date": updated.date, "clue_type": updated.clue_type,
        "domain_tags": updated.domain_tags or cur.get("domain_tags", []),
        "source_credibility": {**sc, "score": updated.credibility, "bias_flags": updated.bias_flags},
    })
    await asyncio.to_thread(writers.set_topic_status, topic_id, "stale")
    _think(topic_id, "✅", "Smart edit complete", f'Updated: "{updated.title}"')
    return await asyncio.to_thread(writers.get_clue, topic_id, clue_id)


# ── Research-extract (Smart Add) ──────────────────────────────────────────────────────
@router.post("/api/topics/{topic_id}/clues/research")
async def research_clues(topic_id: str, body: ResearchBody):
    topic = await _require_topic(topic_id)
    q = body.query.strip()
    if not q:
        raise HTTPException(status_code=400, detail={"message": "query is required"})
    parties = await reads.list_parties(topic_id)
    model = dspy_lm.model_for(topic_id, "extraction")

    def _work():
        with dspy_lm.lm_context(model):
            return clue_intel.smart_extract_research(
                topic["title"], topic["description"], q, parties,
                topic_id=topic_id, emit=lambda e: bus.emit(topic_id, e))

    extracted = await asyncio.to_thread(_work)
    created = []
    for item in extracted:
        cid = await asyncio.to_thread(writers.next_clue_id, topic_id)
        urls = [item.source_url] if item.source_url else []
        outlets = [item.source_outlet] if item.source_outlet else ["research"]
        await asyncio.to_thread(writers.add_clue, topic_id, {
            "id": cid, "title": item.title, "source_urls": urls, "source_outlets": outlets,
            "credibility": item.credibility, "credibility_notes": f"Research: {q[:60]}",
            "bias_flags": item.bias_flags, "summary": item.summary, "relevance": item.relevance,
            "party_relevance": item.parties, "domain_tags": item.domain_tags,
            "timeline_date": item.date or _today(), "date": _now(),
            "clue_type": item.clue_type or "event", "key_points": item.key_points,
            "change_note": f"Research query: {q[:80]}", "status": "verified", "added_by": "research",
        })
        bus.emit(topic_id, {"type": "clue_discovered", "clue_id": cid, "title": item.title,
                            "source": outlets[0], "relevance": item.relevance})
        created.append(await asyncio.to_thread(writers.get_clue, topic_id, cid))
    if created:
        await asyncio.to_thread(writers.set_topic_status, topic_id, "stale")
    return {"imported": len(created), "clues": created, "query": q}


# ── Bulk import (fire-and-forget) ─────────────────────────────────────────────────────
@router.post("/api/topics/{topic_id}/clues/bulk")
async def bulk_import(topic_id: str, body: BulkBody):
    topic = await _require_topic(topic_id)
    content = body.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail={"message": "content is required"})
    job = _bulk_jobs.get(topic_id)
    if not job or job["status"] in ("done", "error"):
        _bulk_jobs[topic_id] = {"status": "running", "stored": 0, "updated": 0, "skipped": 0}
        asyncio.create_task(_run_bulk(topic, content))
    return {"status": _bulk_jobs[topic_id]["status"]}


@router.get("/api/topics/{topic_id}/clues/bulk/status")
async def bulk_status(topic_id: str):
    return _bulk_jobs.get(topic_id) or {"status": "none"}


async def _run_bulk(topic: dict, content: str) -> None:
    tid = topic["id"]
    try:
        parties = await reads.list_parties(tid)
        result = await _bulk_import_agent(topic, content, parties)
        if result["stored"] > 0 or result["updated"] > 0:
            await asyncio.to_thread(writers.set_topic_status, tid, "stale")
        _bulk_jobs[tid] = {"status": "done", **result}
    except Exception as e:  # noqa: BLE001
        _bulk_jobs[tid] = {"status": "error", "stored": 0, "updated": 0, "skipped": 0, "error": str(e)}


# ── Update-all / evidence refresh (fire-and-forget) ───────────────────────────────────
@router.post("/api/topics/{topic_id}/clues/update-all")
async def update_all(topic_id: str):
    topic = await _require_topic(topic_id)
    job = _update_jobs.get(topic_id)
    if not job or job["status"] in ("done", "error"):
        _update_jobs[topic_id] = {"status": "running", "checked": 0, "updated": 0}
        asyncio.create_task(_run_update(topic))
    return {"status": _update_jobs[topic_id]["status"]}


@router.get("/api/topics/{topic_id}/clues/update-all/status")
async def update_all_status(topic_id: str):
    return _update_jobs.get(topic_id) or {"status": "none"}


async def _run_update(topic: dict) -> None:
    tid = topic["id"]
    try:
        clues = await list_clues_api(tid)
        parties = await reads.list_parties(tid)
        result = await _evidence_update_agent(topic, clues, parties)
        if result["updated"] > 0:
            await asyncio.to_thread(writers.set_topic_status, tid, "stale")
        _update_jobs[tid] = {"status": "done", **result}
    except Exception as e:  # noqa: BLE001
        _update_jobs[tid] = {"status": "error", "checked": 0, "updated": 0, "error": str(e)}


# ── Cleanup propose (fire-and-forget) ─────────────────────────────────────────────────
@router.post("/api/topics/{topic_id}/clues/cleanup/propose")
async def cleanup_propose(topic_id: str):
    topic = await _require_topic(topic_id)
    job = _cleanup_jobs.get(topic_id)
    if not job or job["status"] in ("done", "error"):
        _cleanup_jobs[topic_id] = {"status": "running", "groups": None, "original_count": 0}
        asyncio.create_task(_run_cleanup(topic))
    return {"status": _cleanup_jobs[topic_id]["status"]}


@router.get("/api/topics/{topic_id}/clues/cleanup/status")
async def cleanup_status(topic_id: str):
    job = _cleanup_jobs.get(topic_id)
    if job is None:
        return {"status": "none"}
    if job["status"] == "done":
        return {"status": "done", "groups": job["groups"], "original_count": job["original_count"]}
    return {"status": job["status"], "error": job.get("error")}


def _cur_version(clue: dict) -> dict:
    """The clue's current version (or its last, mirroring TS getCur)."""
    return next((v for v in clue["versions"] if v["v"] == clue["current"]),
                clue["versions"][-1] if clue["versions"] else {})


async def _run_cleanup(topic: dict) -> None:
    tid = topic["id"]
    try:
        clues = await list_clues_api(tid)
        parties = await reads.list_parties(tid)
        clue_inputs = []
        for c in clues:
            cur = _cur_version(c)
            sc = cur.get("source_credibility") or {}
            clue_inputs.append({
                "id": c["id"], "title": cur.get("title", ""),
                "summary": cur.get("bias_corrected_summary", ""),
                "date": cur.get("timeline_date", ""), "credibility": sc.get("score", 50),
                "relevance": cur.get("relevance_score", 50), "parties": cur.get("party_relevance", []),
                "clue_type": cur.get("clue_type", "event"), "bias_flags": sc.get("bias_flags", []),
                "domain_tags": cur.get("domain_tags", []),
            })

        model = dspy_lm.model_for(tid, "extraction")

        def _work():
            with dspy_lm.lm_context(model):
                return clue_intel.cleanup_propose(topic["title"], clue_inputs, parties)

        groups = await asyncio.to_thread(_work)
        _cleanup_jobs[tid] = {"status": "done", "groups": [g.model_dump() for g in groups],
                              "original_count": len(clues)}
    except Exception as e:  # noqa: BLE001
        _cleanup_jobs[tid] = {"status": "error", "groups": None, "original_count": 0, "error": str(e)}


# ── Cleanup apply (deterministic merge / renumber; NO LLM) ────────────────────────────
@router.post("/api/topics/{topic_id}/clues/cleanup/apply")
async def cleanup_apply(topic_id: str, body: CleanupApplyBody):
    topic = await _require_topic(topic_id)
    groups = body.groups
    if not groups:
        raise HTTPException(status_code=400, detail={"message": "No groups provided"})
    now = _now()
    today = _today()
    all_clues = await list_clues_api(topic_id)
    clue_map = {c["id"]: c for c in all_clues}

    ids_to_delete: set[str] = set()
    new_clues: list[dict] = []  # [{version: {...}}]

    for g in groups:
        action = g.get("action")
        src_ids = g.get("source_clue_ids", []) or []
        if action == "keep":
            continue
        if action == "delete":
            ids_to_delete.update(src_ids)
            continue
        if action == "merge":
            ids_to_delete.update(src_ids)
            source_clues = [clue_map[i] for i in src_ids if i in clue_map]
            source_clues.sort(key=lambda c: _cur_version(c).get("relevance_score", 0) or 0, reverse=True)
            seen_urls: set[str] = set()
            merged_urls: list[str] = []
            merged_outlets: list[str] = []
            merged_origin: list[dict] = []
            for sc in source_clues:
                cur = _cur_version(sc)
                rs = cur.get("raw_source") or {}
                urls = rs.get("urls") or []
                outlets = rs.get("outlets") or []
                for i, url in enumerate(urls):
                    if url and url not in seen_urls:
                        seen_urls.add(url)
                        merged_urls.append(url)
                        merged_outlets.append(outlets[i] if i < len(outlets) else "")
                for os in (cur.get("source_credibility") or {}).get("origin_sources") or []:
                    osu = os.get("url")
                    if osu and f"os:{osu}" not in seen_urls:
                        seen_urls.add(f"os:{osu}")
                        merged_origin.append(os)
            seen_kp: set[str] = set()
            merged_kp: list[str] = []
            for sc in source_clues:
                for kp in _cur_version(sc).get("key_points") or []:
                    norm = kp.strip().lower()
                    if norm and norm not in seen_kp:
                        seen_kp.add(norm)
                        merged_kp.append(kp.strip())
            src_id_str = ", ".join(c["id"] for c in source_clues)
            new_clues.append({"version": {
                "v": 1, "date": now, "title": g.get("merged_title", ""),
                "raw_source": {"urls": merged_urls, "outlets": merged_outlets, "fetched_at": now},
                "source_credibility": {
                    "score": g.get("merged_credibility") or 60,
                    "notes": f"Merged from {len(source_clues)} clues: {src_id_str}",
                    "bias_flags": g.get("merged_bias_flags") or [],
                    "origin_sources": merged_origin or [{"url": "", "outlet": "consolidated", "is_republication": False}],
                },
                "bias_corrected_summary": g.get("merged_summary", ""),
                "relevance_score": g.get("merged_relevance") or 70,
                "party_relevance": g.get("merged_parties") or [],
                "domain_tags": g.get("merged_domain_tags") or [],
                "timeline_date": g.get("merged_date") or today,
                "clue_type": g.get("merged_clue_type") or "event",
                "change_note": f"Cleanup merge: {g.get('reason', '')}",
                "key_points": merged_kp[:10], "fact_check": {},
            }})

    filtered = [c for c in all_clues if c["id"] not in ids_to_delete]
    renumbered = [{**c, "id": f"clue-{i + 1:03d}"} for i, c in enumerate(filtered)]
    merged_clues = [{
        "id": f"clue-{len(renumbered) + i + 1:03d}", "current": 1, "added_at": now,
        "last_updated_at": now, "added_by": "cleanup", "status": "pending",
        "versions": [nc["version"]],
    } for i, nc in enumerate(new_clues)]

    await asyncio.to_thread(writers.replace_clues, topic_id, renumbered + merged_clues)
    await asyncio.to_thread(writers.set_topic_status, topic_id, "stale")
    asyncio.create_task(_cleanup_factcheck_sweep(topic))

    final = await list_clues_api(topic_id)
    return {
        "original_count": sum(len(g.get("source_clue_ids", []) or []) for g in groups),
        "merged": len(new_clues),
        "deleted": len(ids_to_delete) - len(new_clues),
        "final_count": len(final),
    }


async def _cleanup_factcheck_sweep(topic: dict) -> None:
    """Background adversarial fact-check of all pending/unverified clues after a cleanup apply
    (⇄ TS cleanup/apply background sweep). Always emits stage_complete:cleanup at the end so the
    CluesPanel reloads."""
    tid = topic["id"]
    try:
        all_after = await list_clues_api(tid)
        pending = [c for c in all_after
                   if c["status"] == "pending" or not (_cur_version(c).get("fact_check") or {}).get("verdict")]
        _think(tid, "🔬", f"Fact-checking {len(pending)} pending clue(s)…")
        sem = asyncio.Semaphore(_SWEEP_CONCURRENCY)
        model = dspy_lm.model_for(tid, "extraction")

        async def _check(clue: dict) -> None:
            async with sem:
                cur = _cur_version(clue)
                fields = {
                    "title": cur.get("title", ""),
                    "bias_corrected_summary": cur.get("bias_corrected_summary", ""),
                    "raw_source": cur.get("raw_source", {}),
                    "source_credibility": cur.get("source_credibility", {}),
                    "key_points": cur.get("key_points", []),
                    "party_relevance": cur.get("party_relevance", []),
                }

                def _work():
                    with dspy_lm.lm_context(model):
                        return clue_intel.fact_check_clue(
                            topic["title"], topic["description"], fields,
                            topic_id=tid, emit=lambda e: bus.emit(tid, e))

                try:
                    verdict = await asyncio.to_thread(_work)
                    await asyncio.to_thread(_apply_fact_check, tid, clue["id"], cur, verdict)
                    _think(tid, _verdict_icon(verdict.verdict),
                           f"{verdict.verdict.upper()}: {cur.get('title', '')[:50]}",
                           verdict.bias_analysis[:100])
                except Exception:  # noqa: BLE001 — per-clue failure leaves status pending
                    pass

        await asyncio.gather(*(_check(c) for c in pending))
    except Exception:  # noqa: BLE001
        pass
    finally:
        bus.emit(tid, {"type": "stage_complete", "stage": "cleanup"})


# ── Bounded agent runners ─────────────────────────────────────────────────────────────
async def _bulk_import_agent(topic: dict, content: str, parties: list[dict]) -> dict:
    """Bounded bulk import (⇄ runBulkImportAgent WITHOUT the agentic store_clue loop): smart-chunk
    the content, extract clues from each chunk (existing-clue aware), title-dedupe vs this run AND
    the existing index, store new clues (status pending, added_by user), then fact-check + apply.
    The TS updates_clue_id path (in-place version bump of an existing clue) is dropped as a bounded
    simplification — evidence-update covers refresh. Emits think + stage_complete:bulk_import."""
    tid = topic["id"]
    model = dspy_lm.model_for(tid, "extraction")
    chunks = clue_intel.smart_chunk(content)
    _think(tid, "📋", f"Bulk import: {len(chunks)} chunks to process", f"{len(content)} chars input")
    existing_index = await asyncio.to_thread(writers.clue_index, tid)
    result = {"stored": 0, "updated": 0, "skipped": 0, "chunks": len(chunks)}
    seen_titles: set[str] = set()
    for c in existing_index:
        import re
        seen_titles.add(re.sub(r"[^a-z0-9]", "", (c["title"] or "").lower())[:50])
    sem = asyncio.Semaphore(_BULK_CONCURRENCY)
    import re
    lock = asyncio.Lock()

    async def _process(chunk: str, idx: int) -> None:
        async with sem:
            _think(tid, "📋", f"Processing chunk {idx}/{len(chunks)}", chunk[:80])

            def _extract():
                with dspy_lm.lm_context(model):
                    return clue_intel.smart_extract_from_text(
                        topic["title"], topic["description"], chunk, parties, existing_index)

            try:
                extracted = await asyncio.to_thread(_extract)
            except Exception:  # noqa: BLE001
                return
            for item in extracted:
                key = re.sub(r"[^a-z0-9]", "", (item.title or "").lower())[:50]
                # Hold the lock across id-allocation AND insert: next_clue_id derives the id from
                # COUNT(*), so two concurrent chunks racing here would mint the same id → PRIMARY
                # KEY IntegrityError aborts the whole bulk import. Serializing the store fixes it.
                async with lock:
                    if not key or key in seen_titles:
                        result["skipped"] += 1
                        continue
                    seen_titles.add(key)
                    cid = await asyncio.to_thread(writers.next_clue_id, tid)
                    urls = [item.source_url] if item.source_url else []
                    outlets = [item.source_outlet] if item.source_outlet else []
                    await asyncio.to_thread(writers.add_clue, tid, {
                        "id": cid, "title": item.title, "source_urls": urls, "source_outlets": outlets,
                        "credibility": item.credibility, "credibility_notes": "Bulk import",
                        "bias_flags": item.bias_flags, "summary": item.summary, "relevance": item.relevance,
                        "party_relevance": item.parties, "domain_tags": item.domain_tags,
                        "timeline_date": item.date or _today(), "date": _now(),
                        "clue_type": item.clue_type or "event", "key_points": item.key_points,
                        "change_note": "Bulk import", "status": "pending", "added_by": "user",
                    })
                    result["stored"] += 1
                _think(tid, "📌", f"Stored: {item.title[:50]}", cid)
                cur = await asyncio.to_thread(writers.get_clue, tid, cid)
                cur_v = _cur_version(cur) if cur else {}
                fields = {
                    "title": item.title, "bias_corrected_summary": item.summary,
                    "raw_source": cur_v.get("raw_source", {}),
                    "source_credibility": cur_v.get("source_credibility", {}),
                    "key_points": item.key_points, "party_relevance": item.parties,
                }

                def _fc():
                    with dspy_lm.lm_context(model):
                        return clue_intel.fact_check_clue(
                            topic["title"], topic["description"], fields,
                            topic_id=tid, emit=lambda e: bus.emit(tid, e))

                try:
                    verdict = await asyncio.to_thread(_fc)
                    await asyncio.to_thread(_apply_fact_check, tid, cid, cur_v, verdict)
                    _think(tid, _verdict_icon(verdict.verdict),
                           f"{verdict.verdict.upper()}: {item.title[:50]}", verdict.bias_analysis[:100])
                except Exception:  # noqa: BLE001
                    pass

    await asyncio.gather(*(_process(ch, i + 1) for i, ch in enumerate(chunks)))
    _think(tid, "✅", "Bulk import complete",
           f"{result['stored']} new · {result['updated']} updated · {result['skipped']} skipped")
    bus.emit(tid, {"type": "stage_complete", "stage": "bulk_import"})
    return result


async def _evidence_update_agent(topic: dict, clues: list[dict], parties: list[dict]) -> dict:
    """Bounded evidence refresh (⇄ runEvidenceUpdateAgent): for each clue gather (1 query) + decide
    via UpdateClue; on has_update build a new version (preserving relevance/parties/domain_tags),
    add it, then fact-check + apply. Emits think + stage_complete:evidence_update."""
    tid = topic["id"]
    model = dspy_lm.model_for(tid, "extraction")
    _think(tid, "🔄", f"Checking {len(clues)} clues for updates", _today())
    result = {"checked": 0, "updated": 0, "unchanged": 0}
    sem = asyncio.Semaphore(_UPDATE_CONCURRENCY)

    async def _process(clue: dict) -> None:
        async with sem:
            cur = _cur_version(clue)
            if not cur:
                return
            result["checked"] += 1
            sc = cur.get("source_credibility") or {}
            rs = cur.get("raw_source") or {}
            fields = {
                "title": cur.get("title", ""), "bias_corrected_summary": cur.get("bias_corrected_summary", ""),
                "timeline_date": cur.get("timeline_date", ""), "clue_type": cur.get("clue_type", "event"),
                "raw_source": rs, "source_credibility": sc,
                "key_points": cur.get("key_points", []), "party_relevance": cur.get("party_relevance", []),
            }
            _think(tid, "🔍", f"Checking: {cur.get('title', '')[:60]}",
                   f"Original date: {cur.get('timeline_date', 'unknown')}")

            def _work():
                with dspy_lm.lm_context(model):
                    return clue_intel.update_clue(topic["title"], topic["description"], fields,
                                                 topic_id=tid, emit=lambda e: bus.emit(tid, e))

            try:
                upd = await asyncio.to_thread(_work)
            except Exception:  # noqa: BLE001
                result["unchanged"] += 1
                return
            if not upd.has_update:
                result["unchanged"] += 1
                _think(tid, "✓", f"No updates: {cur.get('title', '')[:50]}", "Up to date")
                return
            new_v = len(clue["versions"]) + 1
            now = _now()
            new_urls = upd.new_source_urls or rs.get("urls") or []
            new_outlets = upd.new_source_outlets or rs.get("outlets") or []
            await asyncio.to_thread(writers.add_clue_version, tid, clue["id"], {
                "v": new_v, "date": now, "title": upd.updated_title or cur.get("title", ""),
                "raw_source": {"urls": new_urls, "outlets": new_outlets, "fetched_at": now},
                "source_credibility": {
                    "score": upd.credibility or sc.get("score", 50),
                    "notes": f"Updated: {upd.update_note or 'new information found'}",
                    "bias_flags": upd.bias_flags or sc.get("bias_flags", []),
                    "origin_sources": [{"url": u, "outlet": (new_outlets[i] if i < len(new_outlets) else u),
                                        "is_republication": False} for i, u in enumerate(new_urls)],
                },
                "bias_corrected_summary": upd.updated_summary or cur.get("bias_corrected_summary", ""),
                "relevance_score": cur.get("relevance_score", 50),
                "party_relevance": cur.get("party_relevance", []),
                "domain_tags": cur.get("domain_tags", []),
                "timeline_date": upd.updated_date or cur.get("timeline_date", ""),
                "clue_type": upd.updated_clue_type or cur.get("clue_type", "event"),
                "change_note": upd.update_note or "Evidence update",
                "key_points": upd.key_points or cur.get("key_points", []), "fact_check": {},
            })
            result["updated"] += 1
            _think(tid, "🔄", f"Updated: {cur.get('title', '')[:50]}", (upd.update_note or "")[:80])
            new_cur = await asyncio.to_thread(writers.get_clue, tid, clue["id"])
            new_cur_v = _cur_version(new_cur) if new_cur else {}
            fc_fields = {
                "title": upd.updated_title or cur.get("title", ""),
                "bias_corrected_summary": upd.updated_summary or cur.get("bias_corrected_summary", ""),
                "raw_source": new_cur_v.get("raw_source", {}),
                "source_credibility": new_cur_v.get("source_credibility", {}),
                "key_points": new_cur_v.get("key_points", []),
                "party_relevance": cur.get("party_relevance", []),
            }

            def _fc():
                with dspy_lm.lm_context(model):
                    return clue_intel.fact_check_clue(topic["title"], topic["description"], fc_fields,
                                                     topic_id=tid, emit=lambda e: bus.emit(tid, e))

            try:
                verdict = await asyncio.to_thread(_fc)
                await asyncio.to_thread(_apply_fact_check, tid, clue["id"], new_cur_v, verdict)
                _think(tid, _verdict_icon(verdict.verdict),
                       f"{verdict.verdict.upper()}: {(upd.updated_title or cur.get('title', ''))[:50]}",
                       verdict.bias_analysis[:100])
            except Exception:  # noqa: BLE001
                pass

    await asyncio.gather(*(_process(c) for c in clues))
    _think(tid, "✅", "Evidence update complete",
           f"{result['updated']} updated · {result['unchanged']} unchanged")
    bus.emit(tid, {"type": "stage_complete", "stage": "evidence_update"})
    return result

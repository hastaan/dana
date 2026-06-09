"""Pipeline routes (⇄ TS routes/pipeline.ts). Phase 1 wires the Discovery stage;
later phases add enrich/forum-prep/forum/score/analyze/run/update.

run_id matches the TS contract exactly: the literal stage name ("discover").
"""
import asyncio
import time

from fastapi import APIRouter, HTTPException

from ..db import topics as topics_repo
from ..db import writers
from ..pipeline import deep_research, discovery, enrichment, forum, forum_prep, scoring
from ..pipeline.runner import registry

router = APIRouter()


def _b36(n: int) -> str:
    """⇄ TS Number.toString(36): lowercase base-36 of a positive int."""
    if n == 0:
        return "0"
    digs = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = digs[r] + out
    return out


@router.post("/api/topics/{topic_id}/pipeline/discover")
async def discover(topic_id: str):
    topic = await topics_repo.get_topic(topic_id)
    if topic is None:
        raise HTTPException(status_code=404, detail={"message": "Topic not found"})

    async def work() -> None:
        await discovery.run_discovery(topic_id, topic["title"], topic["description"])

    started = await registry.start(topic_id, "discover", work)
    if started is None:
        raise HTTPException(status_code=409, detail={"message": "Pipeline already running"})
    return started


@router.post("/api/topics/{topic_id}/pipeline/score")
async def score(topic_id: str):
    topic = await topics_repo.get_topic(topic_id)
    if topic is None:
        raise HTTPException(status_code=404, detail={"message": "Topic not found"})

    async def work() -> None:
        await scoring.run_scoring(topic_id, topic["title"], topic["description"])

    started = await registry.start(topic_id, "score", work)
    if started is None:
        raise HTTPException(status_code=409, detail={"message": "Pipeline already running"})
    return started


@router.post("/api/topics/{topic_id}/pipeline/deep-research")
async def deep_research_stage(topic_id: str, breadth: str = "article"):
    topic = await topics_repo.get_topic(topic_id)
    if topic is None:
        raise HTTPException(status_code=404, detail={"message": "Topic not found"})

    async def work() -> None:
        await deep_research.run_deep_research(topic_id, topic["title"], topic["description"], breadth)

    started = await registry.start(topic_id, "deep-research", work)
    if started is None:
        raise HTTPException(status_code=409, detail={"message": "Pipeline already running"})
    return started


@router.post("/api/topics/{topic_id}/pipeline/enrich")
async def enrich(topic_id: str):
    topic = await topics_repo.get_topic(topic_id)
    if topic is None:
        raise HTTPException(status_code=404, detail={"message": "Topic not found"})

    async def work() -> None:
        await enrichment.run_enrichment(topic_id, topic["title"], topic["description"])

    started = await registry.start(topic_id, "enrich", work)
    if started is None:
        raise HTTPException(status_code=409, detail={"message": "Pipeline already running"})
    return started


@router.post("/api/topics/{topic_id}/pipeline/forum-prep")
async def forum_prep_stage(topic_id: str):
    topic = await topics_repo.get_topic(topic_id)
    if topic is None:
        raise HTTPException(status_code=404, detail={"message": "Topic not found"})

    async def work() -> None:
        await forum_prep.run_forum_prep(topic_id, topic["title"], topic["description"])

    started = await registry.start(topic_id, "forum-prep", work)
    if started is None:
        raise HTTPException(status_code=409, detail={"message": "Pipeline already running"})
    return started


@router.post("/api/topics/{topic_id}/pipeline/forum")
async def forum_stage(topic_id: str):
    topic = await topics_repo.get_topic(topic_id)
    if topic is None:
        raise HTTPException(status_code=404, detail={"message": "Topic not found"})

    async def work() -> None:
        await forum.run_forum(topic_id, topic["title"], topic["description"])

    started = await registry.start(topic_id, "forum", work)
    if started is None:
        raise HTTPException(status_code=409, detail={"message": "Pipeline already running"})
    return started


@router.post("/api/topics/{topic_id}/pipeline/analyze")
async def analyze(topic_id: str):
    """Everything after party review → verdict (⇄ runAnalyzeStages): forum-prep → forum → score."""
    topic = await topics_repo.get_topic(topic_id)
    if topic is None:
        raise HTTPException(status_code=404, detail={"message": "Topic not found"})

    async def work() -> None:
        await forum_prep.run_forum_prep(topic_id, topic["title"], topic["description"])
        await forum.run_forum(topic_id, topic["title"], topic["description"])
        await scoring.run_scoring(topic_id, topic["title"], topic["description"])

    started = await registry.start(topic_id, "analyze", work)
    if started is None:
        raise HTTPException(status_code=409, detail={"message": "Pipeline already running"})
    return started


@router.post("/api/topics/{topic_id}/pipeline/run")
async def run_full(topic_id: str):
    """Full pipeline in one shot (⇄ runFullPipeline): discovery → forum-prep → forum → verdict."""
    topic = await topics_repo.get_topic(topic_id)
    if topic is None:
        raise HTTPException(status_code=404, detail={"message": "Topic not found"})

    async def work() -> None:
        await discovery.run_discovery(topic_id, topic["title"], topic["description"])
        await enrichment.run_enrichment(topic_id, topic["title"], topic["description"])
        await forum_prep.run_forum_prep(topic_id, topic["title"], topic["description"])
        await forum.run_forum(topic_id, topic["title"], topic["description"])
        await scoring.run_scoring(topic_id, topic["title"], topic["description"])

    started = await registry.start(topic_id, "run", work)
    if started is None:
        raise HTTPException(status_code=409, detail={"message": "Pipeline already running"})
    return started


@router.post("/api/topics/{topic_id}/pipeline/update")
async def delta_update(topic_id: str):
    """Delta re-analysis (⇄ TS runDeltaPipeline). Guards: 404 missing / 400 unless status=='stale'
    / 409 if already running. INTERIM: a true clue-version delta (computeDelta + per-rep delta
    turns + state versioning) is not yet ported, so the work body runs a BOUNDED re-analysis
    (forum-prep → forum → score) over the CURRENT clues and clears the stale flag — a real refresh,
    not a fake diff. See DEFERRED notes in the batch report."""
    topic = await topics_repo.get_topic(topic_id)
    if topic is None:
        raise HTTPException(status_code=404, detail={"message": "Topic not found"})
    if topic["status"] != "stale":
        raise HTTPException(status_code=400, detail={"message": "Topic is not stale"})
    run_id = f"delta-{_b36(int(time.time() * 1000))}"

    async def work() -> None:
        await forum_prep.run_forum_prep(topic_id, topic["title"], topic["description"])
        await forum.run_forum(topic_id, topic["title"], topic["description"])
        await scoring.run_scoring(topic_id, topic["title"], topic["description"])
        await asyncio.to_thread(writers.set_topic_status, topic_id, "complete")

    started = await registry.start(topic_id, run_id, work)
    if started is None:
        run = registry.active(topic_id) or {}
        raise HTTPException(status_code=409, detail={"message": "Pipeline already running",
                                                     "running": True, "run": run})
    # Honest signal that this is the INTERIM bounded re-analysis, NOT a true versioned clue-delta
    # (no computeDelta / state-version fork / DeltaRepresentativeAgent yet) — so the UI/audit
    # doesn't mistake it for faithful delta semantics. See DEFERRED notes in the parity batch.
    return {**started, "mode": "reanalysis_fallback"}


@router.post("/api/topics/{topic_id}/pipeline/reanalyze")
async def reanalyze(topic_id: str):
    """Full re-analysis from current clues (⇄ TS /pipeline/reanalyze → runReanalysis). 400 while the
    topic is still in clue/party setup (draft / review_parties)."""
    topic = await topics_repo.get_topic(topic_id)
    if topic is None:
        raise HTTPException(status_code=404, detail={"message": "Topic not found"})
    if topic["status"] in ("draft", "review_parties"):
        raise HTTPException(
            status_code=400,
            detail={"message": f'Cannot re-analyze from status "{topic["status"]}" — need at least enriched clues'},
        )

    async def work() -> None:
        await forum_prep.run_forum_prep(topic_id, topic["title"], topic["description"])
        await forum.run_forum(topic_id, topic["title"], topic["description"])
        await scoring.run_scoring(topic_id, topic["title"], topic["description"])
        await asyncio.to_thread(writers.set_topic_status, topic_id, "complete")

    started = await registry.start(topic_id, "reanalyze", work)
    if started is None:
        run = registry.active(topic_id) or {}
        raise HTTPException(status_code=409, detail={"message": "Pipeline already running",
                                                     "running": True, "run": run})
    return started


@router.get("/api/topics/{topic_id}/pipeline/status")
async def status(topic_id: str):
    run = registry.active(topic_id)
    if run:
        return {"running": True, **run}
    return {"running": False}

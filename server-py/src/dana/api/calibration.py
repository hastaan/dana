"""Calibration routes (⇄ TS routes/calibration.ts).

Resolve a topic's forecast against the real-world outcome → Brier + log score, and aggregate
calibration across all resolved topics (reliability curve). The forecast is taken from the
topic version's scored verdict (final_verdict.scenarios_ranked).
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..db import reads, writers
from ..rigor.calibration import compute_scores, reliability

router = APIRouter()


class ResolveBody(BaseModel):
    resolved_scenario_id: str
    version: int | None = None
    notes: str | None = None


@router.get("/api/calibration")
async def calibration_summary():
    res = await reads.list_resolutions()
    briers = [r["brier_score"] for r in res if r.get("brier_score") is not None]
    logs = [r["log_score"] for r in res if r.get("log_score") is not None]
    return {
        "count": len(res),
        "mean_brier": round(sum(briers) / len(briers), 4) if briers else None,
        "mean_log_score": round(sum(logs) / len(logs), 4) if logs else None,
        "resolutions": res,
        "reliability": reliability(res),
    }


@router.get("/api/topics/{topic_id}/resolution")
async def get_resolution(topic_id: str, version: int = 1):
    return {"resolution": await reads.get_resolution(topic_id, version)}


@router.post("/api/topics/{topic_id}/resolve")
async def resolve(topic_id: str, body: ResolveBody):
    council = await reads.get_expert_council(topic_id, body.version)
    verdict = council.get("final_verdict") if council else None
    if not verdict or not verdict.get("scenarios_ranked"):
        raise HTTPException(status_code=400, detail={"message": "No scored verdict found for this topic/version to resolve against"})
    version = council["version"]
    forecast = [
        {"scenario_id": s.get("scenario_id"), "title": s.get("title"), "probability": s.get("probability", 0)}
        for s in verdict["scenarios_ranked"]
    ]
    if body.resolved_scenario_id not in {f["scenario_id"] for f in forecast}:
        raise HTTPException(status_code=400, detail={
            "message": f'resolved_scenario_id "{body.resolved_scenario_id}" is not in this verdict\'s scenarios'})
    brier, log_score = compute_scores(forecast, body.resolved_scenario_id)
    await _save(topic_id, version, body.resolved_scenario_id, forecast, brier, log_score, body.notes)
    return {"ok": True, "version": version, "brier_score": brier, "log_score": log_score}


@router.delete("/api/topics/{topic_id}/resolution")
async def delete_resolution(topic_id: str, version: int = 1):
    import asyncio
    removed = await asyncio.to_thread(writers.delete_forecast_resolution, topic_id, version)
    return {"ok": removed, "message": None if removed else "No resolution found"}


async def _save(topic_id, version, sid, forecast, brier, log_score, notes):
    import asyncio
    await asyncio.to_thread(writers.save_forecast_resolution, topic_id, version, sid, forecast, brier, log_score, notes)

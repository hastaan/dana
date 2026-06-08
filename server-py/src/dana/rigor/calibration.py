"""Forecast scoring + reliability (⇄ TS db/queries/calibration.ts computeScores).

Brier = Σ(p_i − o_i)² over all scenarios (o_i = 1 for the resolved one). Log score =
−ln(p_resolved). Both lower-is-better. Reliability bins predictions into 10% buckets and
compares predicted mean vs. observed resolution rate. Pure Python.
"""
import math

BUCKETS = [(i / 10, (i + 1) / 10) for i in range(10)]


def compute_scores(forecast: list[dict], resolved_scenario_id: str) -> tuple[float, float | None]:
    brier = 0.0
    p_resolved: float | None = None
    for f in forecast:
        p = float(f.get("probability", 0) or 0)
        o = 1.0 if f.get("scenario_id") == resolved_scenario_id else 0.0
        brier += (p - o) ** 2
        if f.get("scenario_id") == resolved_scenario_id:
            p_resolved = p
    log_score = None if p_resolved is None else -math.log(max(p_resolved, 1e-9))
    return round(brier, 4), (round(log_score, 4) if log_score is not None else None)


def reliability(resolutions: list[dict]) -> list[dict]:
    agg: dict[int, list[float]] = {i: [] for i in range(10)}
    outcomes: dict[int, list[float]] = {i: [] for i in range(10)}
    for r in resolutions:
        rid = r.get("resolved_scenario_id")
        for f in r.get("forecast", []):
            p = float(f.get("probability", 0) or 0)
            idx = min(9, int(p * 10))
            agg[idx].append(p)
            outcomes[idx].append(1.0 if f.get("scenario_id") == rid else 0.0)
    out = []
    for i, (lo, hi) in enumerate(BUCKETS):
        ps = agg[i]
        if not ps:
            continue
        out.append({
            "bucket": f"{int(lo * 100)}-{int(hi * 100)}%",
            "predicted_mean": round(sum(ps) / len(ps), 3),
            "observed_rate": round(sum(outcomes[i]) / len(outcomes[i]), 3),
            "n": len(ps),
        })
    return out

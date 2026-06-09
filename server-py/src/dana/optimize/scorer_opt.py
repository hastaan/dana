"""Compile the ScenarioScorer against Dana's own resolved-forecast track record.

We treat each resolved forecast (forecast_resolutions) as a labelled example: the topic +
parties + evidence that produced a verdict, paired with the outcome that actually resolved.
A DSPy optimizer (BootstrapFewShot, or MIPROv2 when enough data exists) then tunes the
scorer to MINIMISE the Brier score on these examples — i.e. to be better-calibrated on the
kinds of questions this deployment actually asks.

Two honest constraints shape this scaffold:

  • Forecasting is sparse, slow-resolving data. Until ≥ MIN_EXAMPLES forecasts have resolved,
    `optimize_scorer()` is a logged NO-OP — it never raises, never fabricates labels.
  • The scorer invents fresh scenario ids on every run, so the resolved id from a historical
    run will NOT appear in a re-prediction. The metric therefore aligns the prediction's
    scenarios to the historical outcome by TITLE similarity (best-match), then scores the
    full probability vector with the same `compute_scores` Brier the calibration API uses.

Run offline as a script (needs the proxy LLM + resolved data):

    cd server-py && .venv/bin/python -m dana.optimize.scorer_opt

It is intentionally NOT wired into the live pipeline.
"""
from __future__ import annotations

import asyncio
import json
import logging
from difflib import SequenceMatcher
from pathlib import Path

import dspy

from ..agents.scenario_scorer import ScenarioScorer
from ..config import settings
from ..db import reads
from ..llm import dspy_lm
from ..pipeline.scoring import _evidence_str, _parties_str
from ..rigor.calibration import compute_scores
from ..rigor.dedup import independent_density

log = logging.getLogger("dana.optimize.scorer")

# Below this many resolved forecasts, optimization is a no-op (too little signal to compile
# against — bootstrapping/MIPRO on a handful of examples just overfits). Tunable.
MIN_EXAMPLES = 8

# Where the compiled program is persisted (json, via DSPy's program.save).
COMPILED_PATH = Path(settings.db_path).resolve().parent / "compiled_scorer.json"


# ── trainset ──────────────────────────────────────────────────────────────────────────
def _topic_meta(topic_id: str) -> tuple[str, str]:
    """(title, description) for a topic, read straight from sqlite (sync, off-loop)."""
    from ..db.sync_db import connect

    with connect() as c:
        row = c.execute(
            "SELECT title, description FROM topics WHERE id = ?", (topic_id,)
        ).fetchone()
    if not row:
        return "", ""
    return row["title"] or "", row["description"] or ""


async def _build_trainset_async() -> list[dspy.Example]:
    """Load resolved forecasts joined to each version's scored evidence → DSPy Examples.

    Inputs mirror the LIVE scoring stage exactly (same `_parties_str` / `_evidence_str`
    builders) so the compiled program sees production-shaped inputs. The label is the
    resolved outcome (id + title) plus the historical forecast vector for reference.
    """
    resolutions = await reads.list_resolutions()
    examples: list[dspy.Example] = []
    for r in resolutions:
        resolved_id = r.get("resolved_scenario_id")
        forecast = r.get("forecast") or []
        if not resolved_id or not forecast:
            continue  # unresolved / malformed → not a usable label

        topic_id = r["topic_id"]
        title, description = _topic_meta(topic_id)
        if not (title or description) and not (r.get("topic_title")):
            continue  # orphaned resolution (topic deleted) → can't rebuild inputs
        title = title or (r.get("topic_title") or "")

        parties = await reads.list_parties(topic_id)
        clues = await reads.list_clues(topic_id)
        density = independent_density(
            [{"credibility": c.get("credibility") or 50, "relevance": c.get("relevance") or 50,
              "sources": c.get("sources") or []} for c in clues]
        )

        # Resolved scenario's human title (for the title-alignment metric).
        resolved_title = next(
            (f.get("title") for f in forecast if f.get("scenario_id") == resolved_id), ""
        ) or ""

        ex = dspy.Example(
            topic=f"{title}\n{description}".strip(),
            parties_str=_parties_str(parties),
            evidence_str=_evidence_str(clues, density),
            resolved_scenario_id=resolved_id,
            resolved_title=resolved_title,
            forecast=forecast,
        ).with_inputs("topic", "parties_str", "evidence_str")
        examples.append(ex)
    return examples


def build_trainset() -> list[dspy.Example]:
    """Sync wrapper around the async reads (the optimizer runs synchronously)."""
    return asyncio.run(_build_trainset_async())


# ── metric ────────────────────────────────────────────────────────────────────────────
def _similar(a: str, b: str) -> float:
    return SequenceMatcher(None, (a or "").lower().strip(), (b or "").lower().strip()).ratio()


def brier_metric(example: dspy.Example, pred, trace=None) -> float:
    """Calibration score in [0, 1], higher-is-better (DSPy maximises the metric).

    The prediction's scenarios carry FRESH ids, so we align them to the historical resolved
    outcome by title similarity, label that best-match as the "resolved" scenario, then run
    the project's own `compute_scores` Brier over the predicted probability vector. We return
    `1 - brier/2` because multi-class Brier ranges [0, 2] (0 = perfect). On any malformed
    prediction we return 0.0 rather than crash — a bad prediction is simply worst-scoring.
    """
    ranked = getattr(pred, "scenarios_ranked", None) or []
    if not ranked:
        return 0.0
    try:
        forecast = [
            {"scenario_id": s.scenario_id, "title": s.title, "probability": float(s.probability)}
            for s in ranked
        ]
    except (AttributeError, TypeError, ValueError):
        return 0.0

    target = getattr(example, "resolved_title", "") or ""
    best = max(forecast, key=lambda f: _similar(f["title"], target), default=None)
    if best is None:
        return 0.0
    brier, _ = compute_scores(forecast, best["scenario_id"])
    return max(0.0, 1.0 - brier / 2.0)


# ── optimize ──────────────────────────────────────────────────────────────────────────
def _make_optimizer(n_examples: int):
    """BootstrapFewShot for small sets; MIPROv2 once there's enough data to search prompts."""
    from dspy.teleprompt import BootstrapFewShot

    if n_examples >= 20:
        from dspy.teleprompt import MIPROv2

        log.info("optimize-scorer: using MIPROv2 (%d examples)", n_examples)
        return MIPROv2(metric=brier_metric, auto="light")
    log.info("optimize-scorer: using BootstrapFewShot (%d examples)", n_examples)
    return BootstrapFewShot(metric=brier_metric, max_bootstrapped_demos=4, max_labeled_demos=4)


def optimize_scorer(min_examples: int = MIN_EXAMPLES,
                    save_path: Path | str = COMPILED_PATH) -> ScenarioScorer | None:
    """Compile ScenarioScorer against resolved forecasts, or NO-OP if too little data.

    Returns the compiled program (also saved to `save_path`) on success, else None. Never
    raises on the insufficient-data path — that is the expected state for a fresh deployment.
    """
    trainset = build_trainset()
    n = len(trainset)
    if n < min_examples:
        log.warning(
            "optimize-scorer: insufficient resolved-forecast data (%d usable resolved "
            "forecast(s), need >= %d) — NOT optimizing. Resolve more topics "
            "(POST /api/topics/{id}/resolve) and re-run. No-op.",
            n, min_examples,
        )
        return None

    log.info("optimize-scorer: compiling ScenarioScorer on %d resolved example(s)…", n)
    with dspy_lm.lm_context():
        optimizer = _make_optimizer(n)
        compiled = optimizer.compile(ScenarioScorer(), trainset=trainset)

        save_path = Path(save_path)
        save_path.parent.mkdir(parents=True, exist_ok=True)
        compiled.save(str(save_path))
        mean_score = sum(brier_metric(ex, compiled(**ex.inputs())) for ex in trainset) / n  # noqa: E501
    log.info("optimize-scorer: saved compiled program → %s (train metric ≈ %.3f)",
             save_path, mean_score)
    return compiled


def load_compiled(save_path: Path | str = COMPILED_PATH) -> ScenarioScorer | None:
    """Load a previously-compiled scorer if one exists on disk, else None.

    Provided for a future opt-in wiring step; the live pipeline does NOT call this yet.
    """
    save_path = Path(save_path)
    if not save_path.exists():
        return None
    prog = ScenarioScorer()
    prog.load(str(save_path))
    return prog


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    result = optimize_scorer()
    if result is None:
        print(json.dumps({"optimized": False, "reason": "insufficient_resolved_data",
                          "min_examples": MIN_EXAMPLES}))
    else:
        print(json.dumps({"optimized": True, "compiled_path": str(COMPILED_PATH)}))


if __name__ == "__main__":
    main()

"""Unit tests for rigor/calibration.py — Brier / log score + reliability bins. Pure math."""
import math

from dana.rigor.calibration import compute_scores, reliability


class TestComputeScores:
    def test_perfect_forecast(self):
        forecast = [
            {"scenario_id": "a", "probability": 1.0},
            {"scenario_id": "b", "probability": 0.0},
        ]
        brier, log_score = compute_scores(forecast, "a")
        # (1-1)^2 + (0-0)^2 = 0 ; -ln(1) = 0
        assert brier == 0.0
        assert log_score == 0.0

    def test_worst_forecast(self):
        forecast = [
            {"scenario_id": "a", "probability": 0.0},
            {"scenario_id": "b", "probability": 1.0},
        ]
        brier, log_score = compute_scores(forecast, "a")
        # (0-1)^2 + (1-0)^2 = 2 ; -ln(max(0, 1e-9)) ≈ 20.7233
        assert brier == 2.0
        assert log_score == round(-math.log(1e-9), 4)

    def test_uniform_forecast(self):
        forecast = [
            {"scenario_id": "a", "probability": 0.5},
            {"scenario_id": "b", "probability": 0.5},
        ]
        brier, log_score = compute_scores(forecast, "a")
        # (0.5-1)^2 + (0.5-0)^2 = 0.25 + 0.25 = 0.5 ; -ln(0.5) ≈ 0.6931
        assert brier == 0.5
        assert log_score == round(-math.log(0.5), 4)

    def test_resolved_scenario_not_in_forecast(self):
        forecast = [
            {"scenario_id": "a", "probability": 0.6},
            {"scenario_id": "b", "probability": 0.4},
        ]
        brier, log_score = compute_scores(forecast, "missing")
        # all outcomes 0: 0.36 + 0.16 = 0.52 ; no p_resolved → log None
        assert brier == 0.52
        assert log_score is None

    def test_handles_none_and_string_probabilities(self):
        forecast = [
            {"scenario_id": "a", "probability": None},
            {"scenario_id": "b", "probability": "0.3"},
        ]
        brier, log_score = compute_scores(forecast, "b")
        # a: (0-0)^2 = 0 ; b: (0.3-1)^2 = 0.49 ; -ln(0.3)
        assert brier == 0.49
        assert log_score == round(-math.log(0.3), 4)


class TestReliability:
    def test_empty(self):
        assert reliability([]) == []

    def test_only_nonempty_buckets_returned(self):
        resolutions = [
            {"resolved_scenario_id": "a", "forecast": [
                {"scenario_id": "a", "probability": 0.85},
                {"scenario_id": "b", "probability": 0.15},
            ]},
        ]
        out = reliability(resolutions)
        buckets = {row["bucket"] for row in out}
        assert buckets == {"80-90%", "10-20%"}

    def test_predicted_and_observed_rates(self):
        # Two predictions both land in the 80-90% bucket (int(p*10)==8), one resolved true.
        resolutions = [
            {"resolved_scenario_id": "a", "forecast": [{"scenario_id": "a", "probability": 0.80}]},
            {"resolved_scenario_id": "x", "forecast": [{"scenario_id": "a", "probability": 0.85}]},
        ]
        out = reliability(resolutions)
        row = next(r for r in out if r["bucket"] == "80-90%")
        assert row["n"] == 2
        assert row["predicted_mean"] == round((0.80 + 0.85) / 2, 3)
        assert row["observed_rate"] == 0.5  # 1 of 2 resolved

    def test_probability_one_lands_in_top_bucket(self):
        # p=1.0 → idx capped at 9 (the 90-100% bucket), not out of range.
        resolutions = [
            {"resolved_scenario_id": "a", "forecast": [{"scenario_id": "a", "probability": 1.0}]},
        ]
        out = reliability(resolutions)
        assert any(r["bucket"] == "90-100%" and r["observed_rate"] == 1.0 for r in out)

"""Unit tests for agents/scenario_scorer._normalize — probability normalization.

Pure Python (never trust the LLM to sum to 1.0). No LLM/network: we build RankedScenario
objects directly and check the normalized output sums to 1.0 and is sorted descending.
"""
from dana.agents.scenario_scorer import RankedScenario, _normalize


def _mk(sid: str, prob: float) -> RankedScenario:
    return RankedScenario(scenario_id=sid, title=sid.upper(), probability=prob)


def _sum(ranked: list[RankedScenario]) -> float:
    return round(sum(r.probability for r in ranked), 3)


class TestNormalize:
    def test_renormalizes_to_one(self):
        ranked = _normalize([_mk("a", 0.6), _mk("b", 0.6), _mk("c", 0.3)])  # sums to 1.5
        assert _sum(ranked) == 1.0

    def test_sorted_descending(self):
        ranked = _normalize([_mk("a", 0.2), _mk("b", 0.5), _mk("c", 0.3)])
        probs = [r.probability for r in ranked]
        assert probs == sorted(probs, reverse=True)
        assert ranked[0].scenario_id == "b"

    def test_already_normalized_left_within_tolerance(self):
        # sums to exactly 1.0 → untouched (sorted only)
        ranked = _normalize([_mk("a", 0.7), _mk("b", 0.3)])
        assert _sum(ranked) == 1.0
        assert ranked[0].scenario_id == "a"
        assert ranked[0].probability == 0.7

    def test_all_zero_becomes_uniform(self):
        # All-zero → equal split round(1/3,3)=0.333 each (sums to 0.999 after rounding).
        ranked = _normalize([_mk("a", 0.0), _mk("b", 0.0), _mk("c", 0.0)])
        for r in ranked:
            assert r.probability == round(1.0 / 3, 3)
        # uniform two-way splits exactly to 1.0
        two = _normalize([_mk("a", 0.0), _mk("b", 0.0)])
        assert _sum(two) == 1.0

    def test_output_probabilities_stay_in_range(self):
        # Every normalized probability remains a valid [0,1] value, summing to ~1
        # (3-decimal rounding can leave a tiny residue, so allow a small tolerance).
        ranked = _normalize([_mk("a", 0.9), _mk("b", 0.9), _mk("c", 0.9)])
        assert abs(_sum(ranked) - 1.0) <= 0.01
        assert all(0.0 <= r.probability <= 1.0 for r in ranked)

    def test_single_scenario_normalizes_to_one(self):
        ranked = _normalize([_mk("only", 0.42)])
        assert len(ranked) == 1
        assert ranked[0].probability == 1.0

    def test_empty_list(self):
        assert _normalize([]) == []

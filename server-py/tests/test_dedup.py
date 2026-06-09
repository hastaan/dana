"""Unit tests for rigor/dedup.py — evidence-independence dedup. Pure logic, no network/LLM."""
from dana.rigor.dedup import effective_weight, independent_density


class TestEffectiveWeight:
    def test_basic_weight(self):
        # 80 credibility * (90/100) relevance * 10, rounded to 1dp
        assert effective_weight(80, 90) == 72.0

    def test_full_credibility_full_relevance(self):
        assert effective_weight(100, 100) == 100.0

    def test_bias_flags_penalize_credibility(self):
        # 2 bias flags drop credibility by 10 (5 each): (80-10) * 1.0 * 10 = 70
        assert effective_weight(80, 100, bias_flags=2) == 70.0

    def test_credibility_floor_is_ten(self):
        # heavy bias can't push credibility below 10: max(10, 20-50)=10 → 10*1.0*10/10 = 10.0
        assert effective_weight(20, 100, bias_flags=10) == 10.0

    def test_relevance_scales_linearly(self):
        assert effective_weight(50, 50) == 25.0


class TestIndependentDensity:
    def test_empty(self):
        out = independent_density([])
        assert out == {"raw_density": 0.0, "independent_density": 0.0, "source_clusters": 0}

    def test_single_clue(self):
        out = independent_density([
            {"credibility": 80, "relevance": 90, "sources": ["https://nytimes.com/a"]},
        ])
        assert out["raw_density"] == 72.0
        assert out["independent_density"] == 72.0
        assert out["source_clusters"] == 1

    def test_same_domain_clusters_keep_strongest(self):
        # Two clues from the same primary domain → one cluster, strongest effective weight wins.
        clues = [
            {"credibility": 80, "relevance": 90, "sources": ["https://nytimes.com/a"]},  # ew 72
            {"credibility": 60, "relevance": 50, "sources": ["https://www.nytimes.com/b"]},  # ew 30
        ]
        out = independent_density(clues)
        assert out["source_clusters"] == 1
        assert out["raw_density"] == 102.0  # 72 + 30
        assert out["independent_density"] == 72.0  # strongest of the single cluster

    def test_distinct_domains_are_independent(self):
        clues = [
            {"credibility": 80, "relevance": 90, "sources": ["https://nytimes.com/a"]},  # ew 72
            {"credibility": 80, "relevance": 90, "sources": ["https://bbc.com/b"]},  # ew 72
        ]
        out = independent_density(clues)
        assert out["source_clusters"] == 2
        assert out["raw_density"] == 144.0
        assert out["independent_density"] == 144.0

    def test_sourceless_clues_are_solo_clusters(self):
        # No sources → each clue is its own solo cluster (never merged together).
        clues = [
            {"credibility": 50, "relevance": 100, "sources": []},  # ew 50
            {"credibility": 50, "relevance": 100},  # ew 50
        ]
        out = independent_density(clues)
        assert out["source_clusters"] == 2
        assert out["independent_density"] == 100.0

    def test_bias_flags_list_length_penalizes(self):
        out = independent_density([
            {"credibility": 80, "relevance": 100, "bias_flags": ["state", "partisan"],
             "sources": ["https://presstv.ir/x"]},
        ])
        # (80 - 2*5) * 1.0 * 10 = 700/10 = 70.0
        assert out["independent_density"] == 70.0

    def test_defaults_when_fields_missing(self):
        out = independent_density([{"sources": ["https://example.com/a"]}])
        # defaults credibility=50, relevance=50 → 50*0.5*10 = 25.0
        assert out["independent_density"] == 25.0

"""Unit tests for tools/web_search.py — the relevance FLOOR + keyword distillation.

Pure logic, NO network/LLM. These lock in the two defenses that keep search HONEST from a
flagged datacenter IP (where scrapers return off-topic anti-bot fallback junk):
  - rerank_results(): drops zero-query-overlap junk (→ honest empty, never nonsense)
  - distill_query():  a cheap, no-LLM keyword variant for a second search shot
"""
from dana.tools.web_search import distill_query, rerank_results


def _r(title="", snippet="", url="https://example.com/x"):
    return {"title": title, "url": url, "snippet": snippet}


class TestRelevanceFloor:
    def test_all_junk_dropped_to_empty(self):
        # Every result is off-topic for a ≥2-term query → honest empty, not nonsense.
        junk = [_r("Home Loan — Apply Online"), _r("Pogoda długoterminowa Berezka"),
                _r("Cross Icons & Symbols")]
        assert rerank_results("Iranian regime collapse opposition", junk) == []

    def test_mixed_keeps_relevant_drops_junk(self):
        results = [
            _r("Home Loan — Apply Online", url="https://bank.example/loan"),
            _r("Iran's regime faces collapse", "opposition gains ground",
               url="https://news.example/iran"),
            _r("Boots Pharmacy", url="https://boots.example"),
        ]
        out = rerank_results("Iranian regime collapse", results)
        urls = [r["url"] for r in out]
        assert "https://news.example/iran" in urls
        assert "https://bank.example/loan" not in urls and "https://boots.example" not in urls

    def test_single_term_query_skips_floor(self):
        # <2 content terms → snippets are often sparse, so the floor is skipped (keep all).
        results = [_r("Totally unrelated"), _r("Also unrelated")]
        assert len(rerank_results("Iran", results)) == 2

    def test_empty_in_empty_out(self):
        assert rerank_results("Iranian regime collapse", []) == []

    def test_title_overlap_ranks_above_snippet_only(self):
        results = [
            _r("Generic page", "mentions regime collapse in passing", url="https://a"),
            _r("Iranian regime collapse explained", "analysis", url="https://b"),
        ]
        out = rerank_results("Iranian regime collapse", results)
        assert out[0]["url"] == "https://b"  # title overlap (×2 weight) wins


class TestDistillQuery:
    def test_long_query_distilled_to_content_keywords(self):
        out = distill_query("Islamic Republic regime collapse and formation of a new Iranian state")
        toks = out.split()
        assert len(toks) <= 6
        assert "and" not in toks and "of" not in toks and "a" not in toks  # stopwords dropped
        assert "new" not in [t.lower() for t in toks]                       # weak adjective dropped
        assert "Iranian" in toks                                            # key entity survives
        # order-preserving
        assert toks == ["Islamic", "Republic", "regime", "collapse", "formation", "Iranian"]

    def test_dedup_preserves_first_occurrence(self):
        assert distill_query("Iran Iran iran regime") == "Iran regime"

    def test_all_stopwords_returns_empty(self):
        assert distill_query("the of a an and") == ""

    def test_short_query_unchanged(self):
        assert distill_query("Iran regime collapse") == "Iran regime collapse"

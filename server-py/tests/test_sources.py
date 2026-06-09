"""Unit tests for rigor/sources.py — adversarial source filter.

Keeps legitimate-but-biased outlets (state/partisan media like presstv.ir, rt.com); drops only
fabrication / hoax / SEO-spam domains (e.g. infowars.com).
"""
from dana.rigor.sources import domain_of, filter_sources, is_valid_source


class TestIsValidSource:
    def test_keeps_state_media_presstv(self):
        assert is_valid_source("https://presstv.ir/news/article") is True

    def test_keeps_state_media_rt(self):
        assert is_valid_source("https://www.rt.com/news/123") is True

    def test_keeps_mainstream(self):
        assert is_valid_source("https://www.bbc.com/news/world") is True

    def test_drops_infowars(self):
        assert is_valid_source("https://www.infowars.com/article") is False

    def test_drops_satire_onion(self):
        assert is_valid_source("https://www.theonion.com/story") is False

    def test_drops_subdomain_of_unreliable(self):
        assert is_valid_source("https://blog.infowars.com/x") is False

    def test_rejects_non_http(self):
        assert is_valid_source("ftp://example.com") is False
        assert is_valid_source("not a url") is False

    def test_rejects_empty(self):
        assert is_valid_source("") is False

    def test_www_normalized(self):
        # exact match against UNRELIABLE_DOMAINS works regardless of leading www.
        assert is_valid_source("https://www.naturalnews.com/x") is False


class TestDomainOf:
    def test_strips_www_and_lowercases(self):
        assert domain_of("https://WWW.Example.COM/Path") == "example.com"

    def test_invalid_returns_empty(self):
        assert domain_of("garbage") == ""


class TestFilterSources:
    def test_drops_unreliable_keeps_order(self):
        results = [
            {"url": "https://presstv.ir/a"},
            {"url": "https://infowars.com/b"},
            {"url": "https://rt.com/c"},
        ]
        kept = filter_sources(results)
        assert [r["url"] for r in kept] == ["https://presstv.ir/a", "https://rt.com/c"]

    def test_custom_url_key(self):
        results = [{"link": "https://bbc.com/x"}, {"link": "https://huzlers.com/y"}]
        kept = filter_sources(results, url_key="link")
        assert [r["link"] for r in kept] == ["https://bbc.com/x"]

    def test_missing_url_dropped(self):
        assert filter_sources([{"url": ""}, {}]) == []

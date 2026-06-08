"""Smoke: the STORM research engine end-to-end on a throwaway topic (tiny budget).

Proves analogues -> personas -> grounded web search -> distilled clues against the live
SearXNG + CLIProxyAPI. Run: .venv/bin/python tests/smoke_research.py
"""
import os

os.environ.setdefault("DANA_RESEARCH_MAX_PERSONAS", "2")
os.environ.setdefault("DANA_RESEARCH_MAX_TURNS", "2")
os.environ.setdefault("DANA_RESEARCH_TOP_K", "3")
os.environ.setdefault("DANA_RESEARCH_MAX_SEARCHES", "8")

from dana.db import writers  # noqa: E402
from dana.llm import dspy_lm  # noqa: E402
from dana.research.engine import ResearchConfig, StormResearchEngine  # noqa: E402


def main() -> None:
    dspy_lm.configure()
    topic = writers.create_topic(
        "SMOKE: Israel-Hezbollah 2024 ceasefire durability",
        "Will the November 2024 Israel-Hezbollah ceasefire hold, and what could break it?",
    )
    print("topic:", topic["id"])

    def show(e: dict) -> None:
        if e.get("type") in ("think", "clue_discovered"):
            print(f"  · {e.get('icon','')} {e.get('label', e.get('clue',{}).get('title',''))}: {str(e.get('detail',''))[:120]}", flush=True)

    engine = StormResearchEngine(topic["id"], ResearchConfig())
    res = engine.run(topic["title"], topic["description"], show)

    print("\nparties:", [p["name"] for p in res["parties"]])
    print("outline:", res["outline"])
    print(f"clues: {len(res['clues'])}  searches: {res['searches_used']}  cache_hits: {res['cache_hits']}")
    for c in res["clues"][:6]:
        print(f"  - {c['title'][:64]}  | parties={c['party_relevance']} | sources={len(c['source_urls'])}")

    writers.set_parties(topic["id"], res["parties"])
    for c in res["clues"]:
        writers.add_clue(topic["id"], c)
    print("\npersisted clues in DB:", writers.count_clues(topic["id"]))
    assert res["parties"], "should discover parties"
    assert res["clues"], "should produce clues"
    print("✅ STORM research engine works end-to-end (real search → clues).")


if __name__ == "__main__":
    main()

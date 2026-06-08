"""Smoke: the unified internet-lookup tiers (quick already verified inline).

Runs deep_lookup (1 question → grounded answer) and deep_search(breadth=clue) (bounded
multi-angle briefing). Usage: python -u tests/smoke_internet.py
"""
import sys
import time

sys.path.insert(0, "src")

from dana.research.deep_search import deep_search  # noqa: E402
from dana.research.internet import deep_lookup  # noqa: E402

Q = "What were the main terms of the November 2024 Israel-Hezbollah ceasefire?"


def main() -> None:
    t = time.time()
    print("=== deep_lookup ===", flush=True)
    dl = deep_lookup(Q, topic_id="smoke-internet")
    print(f"status={dl['status']} sources={dl['source_count']} searches={dl['searches_used']} ({time.time()-t:.0f}s)")
    print("answer:", (dl["answer"] or "")[:400])
    print("source urls:", dl["source_urls"][:4])

    t = time.time()
    print("\n=== deep_search (breadth=clue) ===", flush=True)
    ds = deep_search("November 2024 Israel-Hezbollah ceasefire durability", breadth="clue", topic_id="smoke-internet")
    print(f"status={ds['status']} findings={ds['findings_count']} sources={len(ds['sources'])} "
          f"searches={ds['searches_used']} ({time.time()-t:.0f}s)")
    print("briefing[:500]:", (ds["content"] or "")[:500])
    print("source count:", len(ds["sources"]))


main()

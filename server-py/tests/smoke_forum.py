"""Smoke: forum-prep → forum debate → scoring against an existing topic (with parties+clues).

Bounded via DANA_FORUM_MAX_PARTIES (default 2 here) so it finishes quickly.
Usage: python -u tests/smoke_forum.py [topic_id]
"""
import asyncio
import os
import sys

sys.path.insert(0, "src")
os.environ.setdefault("DANA_FORUM_MAX_PARTIES", "2")

from dana.db import reads  # noqa: E402
from dana.db import topics as repo  # noqa: E402
from dana.pipeline import forum, forum_prep, scoring  # noqa: E402

TOPIC = sys.argv[1] if len(sys.argv) > 1 else "iri-regime-collapse-and-formation-of-a-new-iranian-state-mnnfahns"


async def main() -> None:
    t = await repo.get_topic(TOPIC)
    if not t:
        print("topic not found:", TOPIC); return
    title, desc = t["title"], t["description"] or ""
    print(f"=== forum-prep '{title}' ===", flush=True)
    await forum_prep.run_forum_prep(TOPIC, title, desc)
    reps = await reads.list_representatives(TOPIC)
    print(f"representatives: {len(reps)}")
    for r in reps[:4]:
        print(f"  {r['persona_title']}  weight={r['speaking_weight']}  budget={r['speaking_budget']}")

    print("\n=== forum debate ===", flush=True)
    fres = await forum.run_forum(TOPIC, title, desc)
    sess = await reads.get_forum_session(TOPIC)
    print(f"session={sess['session_id']} status={sess['status']} rounds={len(sess['rounds'])}")
    for rnd in sess["rounds"]:
        print(f"  round {rnd['round']} ({rnd['type']}): {len(rnd['turns'])} turns")
        for tn in rnd["turns"]:
            print(f"     {tn['party_name']}: {tn['statement'][:90]}…  [cited {len(tn['clues_cited'])} clues]")
    print(f"forum scenarios: {len(sess['scenarios'])}")
    for s in sess["scenarios"]:
        print(f"  - {s['title'][:80]}  (backed by {s['supported_by']})")
    print("debate_summary:", (sess["debate_summary"] or "")[:240])

    print("\n=== scoring (consumes forum) ===", flush=True)
    sres = await scoring.run_scoring(TOPIC, title, desc)
    for s in sres["scenarios_ranked"]:
        print(f"  {s['probability']:.0%}  {s['title']}")


asyncio.run(main())

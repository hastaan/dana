"""Smoke: run the scoring stage against an existing topic (with clues) → ranked verdict.

Usage: python -u tests/smoke_scoring.py [topic_id]
Defaults to the IRI-regime-collapse topic (78 clues, 9 parties) in the dev DB.
"""
import asyncio
import sys

sys.path.insert(0, "src")

from dana.db import reads  # noqa: E402
from dana.pipeline import scoring  # noqa: E402

TOPIC = sys.argv[1] if len(sys.argv) > 1 else "iri-regime-collapse-and-formation-of-a-new-iranian-state-mnnfahns"


async def main() -> None:
    from dana.db import topics as repo
    t = await repo.get_topic(TOPIC)
    if not t:
        print("topic not found:", TOPIC)
        return
    print(f"=== scoring '{t['title']}' ===", flush=True)
    res = await scoring.run_scoring(TOPIC, t["title"], t["description"] or "")
    print(f"\n--- {len(res['scenarios_ranked'])} scenarios ranked ---")
    for s in res["scenarios_ranked"]:
        print(f"  {s['probability']:.0%}  {s['title']}  [conf {s['confidence']}, base {s.get('base_rate')}]")
        print(f"        resolve: {(s.get('resolution_criteria') or '')[:90]}")

    # read it back through the API path
    council = await reads.get_expert_council(TOPIC)
    v = council["final_verdict"]
    print("\n--- read back via get_expert_council ---")
    print("scenarios persisted:", len(v["scenarios_ranked"]))
    print("final_assessment:", v["final_assessment"][:200])
    print("confidence_note:", v["confidence_note"][:160])


asyncio.run(main())

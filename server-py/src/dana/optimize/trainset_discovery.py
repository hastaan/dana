"""Discovery training examples for future DSPy optimization of SeedPerspectives.

Parallel to `scorer_opt.py` (which compiles the ScenarioScorer against resolved forecasts),
this module turns HUMAN-CORRECTED discovery fixtures into `dspy.Example`s. The first case is
the Iranian-opposition structure (see dana.research.gold.iri_opposition): a topic where naive
auto-discovery FLATTENED / SCATTERED three mutually-incompatible opposition currents and
mis-weighted them by diaspora-media visibility instead of domestic popular support.

These Examples mirror the LIVE SeedPerspectives signature inputs (topic, description,
analogues) and carry the corrected bloc structure + the general guidance principle as the
label, so a future optimizer can teach discovery the general lesson without hardcoding Iran
facts into the prompt.

Strictly opt-in / offline. Nothing here runs during the live pipeline, and building the
trainset makes NO live web/LLM calls — it is data-only, assembled from the gold fixtures.
A `main()` is provided so the trainset can be inspected:

    cd server-py && .venv/bin/python -m dana.optimize.trainset_discovery
"""
from __future__ import annotations

import json

import dspy

from ..research.gold.iri_opposition import (
    COALITION_RULE,
    GOLD_OPPOSITION_BLOCS,
    IRI_OPPOSITION_GOLD,
    get_discovery_guidance,
)


def _blocs_label(blocs: list[dict]) -> str:
    """Render the corrected, mutually-incompatible blocs as a compact label string."""
    lines = []
    for b in blocs:
        rivals = ", ".join(b.get("incompatible_with", [])) or "(none)"
        lines.append(
            f"- {b['name']} [id={b['id']}, support_rank={b.get('support_rank')}]\n"
            f"    agenda: {b['agenda']}\n"
            f"    incompatible_with: {rivals}\n"
            f"    why: {b['why']}"
        )
    return "\n".join(lines)


def _iri_description() -> str:
    """A description that frames the scenario without leaking the corrected answer — the
    same shape SeedPerspectives sees live (the label carries the correction, not the input)."""
    return (
        "Scenario: collapse of the Islamic Republic of Iran and the formation of a new "
        "Iranian state. The anti-regime/opposition field is fragmented across several "
        "competing currents that want incompatible successor outcomes."
    )


def build_discovery_examples() -> list[dspy.Example]:
    """Return human-corrected discovery cases as DSPy Examples for future optimization.

    Each Example's INPUTS match the SeedPerspectives signature (topic, description,
    analogues). The label fields capture the corrected structure the model should learn:
      - `gold_blocs`        : the mutually-incompatible blocs (must NOT be coalesced),
      - `coalition_rule`    : the weight + no-coalesce rule,
      - `gold_blocs_str`    : a human-readable rendering of the blocs,
      - `guidance`          : the GENERAL principle (rival factions / popular-support weight).

    Data-only: no live calls. Currently one case (IRI opposition); add more by appending
    further gold fixtures (see docs/GOLD_EXAMPLES.md).
    """
    iri = dspy.Example(
        topic=IRI_OPPOSITION_GOLD["topic"],
        description=_iri_description(),
        analogues="",  # discovery can run without analogues; left blank for the gold case
        gold_blocs=GOLD_OPPOSITION_BLOCS,
        gold_blocs_str=_blocs_label(GOLD_OPPOSITION_BLOCS),
        coalition_rule=COALITION_RULE,
        guidance=get_discovery_guidance(),
    ).with_inputs("topic", "description", "analogues")
    return [iri]


def main() -> None:
    examples = build_discovery_examples()
    print(json.dumps(
        {
            "count": len(examples),
            "topics": [ex.topic for ex in examples],
            "guidance": get_discovery_guidance(),
        },
        indent=2,
    ))


if __name__ == "__main__":
    main()

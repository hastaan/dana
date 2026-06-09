"""Gold fixture: the Iranian-opposition (IRI regime-collapse) party structure.

This is the HUMAN-CORRECTED truth taken from the live DB after a human reviewed the naive
auto-discovery for topic `iri-regime-collapse-and-formation-of-a-new-iranian-state-mnnfahns`.
It teaches discovery two GENERAL lessons (see get_discovery_guidance):

  • Do NOT flatten / scatter rival opposition currents that cannot coalesce — keep them as
    DISTINCT blocs and record their mutual hostility.
  • Weight factions by REALISTIC DOMESTIC POPULAR SUPPORT, not organizational visibility or
    diaspora-media presence.

The naive run (data/topics/.../logs/run-run-v1/discovery_output.json) scattered the three
incompatible opposition currents as unrelated, near-zero-weight single parties:
  - `reza_pahlavi_network`              (type diaspora_network, weight 4)
  - `ncri_pmoi_mek_under_maryam_raj`    (type opposition_group,  weight 3)
  - `pjak`                              (type militia,           weight 4)
…with NO reformist/republican/anti-war-left bloc present at all, no signal that the
currents are mutually incompatible, and weights that buried Reza Pahlavi's largest domestic
base (own evidence cited GAMAAN: 31% — the LARGEST opposition base) below external-state and
regime actors. That is exactly the flatten-and-mis-weight failure this fixture corrects.

This module is data-only (no live calls). It is consumed by:
  - dana.optimize.trainset_discovery.build_discovery_examples() — as a DSPy training Example.
  - docs/GOLD_EXAMPLES.md — for the documented before→after delta.
"""
from __future__ import annotations

from typing import Any

# The concise, GENERAL principle appended to the SeedPerspectives instruction. Kept here as
# the single source of truth and re-exported so the signature and docs can't drift.
DISCOVERY_GUIDANCE: str = (
    "When several actors compete to lead, succeed, or replace a regime, distinguish rival "
    "opposition/successor factions that cannot coalesce: keep mutually-hostile currents as "
    "separate parties rather than merging or scattering them, and weight factions by "
    "realistic domestic popular support, not organizational visibility or diaspora-media "
    "presence."
)


def get_discovery_guidance() -> str:
    """Return the concise, GENERAL discovery principle (rival factions / popular-support
    weighting). NOT Iran-specific — the specifics live in IRI_OPPOSITION_GOLD and
    docs/GOLD_EXAMPLES.md. Imported by signatures.py to extend the SeedPerspectives docstring
    and by trainset_discovery.py as the labelled guidance for the gold Example."""
    return DISCOVERY_GUIDANCE


# ── The human-corrected opposition structure (the AFTER) ───────────────────────────────
# Three MUTUALLY-INCOMPATIBLE blocs. They must NOT be coalesced into one party. Relative
# weight reflects what the Iranian MAJORITY wants: Pahlavi >> reformist/republican > MEK/NCRI.
GOLD_OPPOSITION_BLOCS: list[dict[str, Any]] = [
    {
        "id": "iran_pahlavi_constitutional_bloc",
        "name": "Pahlavi-aligned secular / constitutional-transition bloc (Reza Pahlavi)",
        "type": "non_state",
        "support_rank": 1,  # LARGEST real domestic base among opposition currents
        "agenda": (
            "Lead a secular, constitutional transition from the Islamic Republic, drawing on "
            "the largest domestic opposition base and broad name recognition around Reza Pahlavi."
        ),
        "why": (
            "Holds the LARGEST real domestic base among opposition currents (polling such as "
            "GAMAAN repeatedly puts Reza Pahlavi as the single most-supported opposition figure). "
            "Secular/constitutional-transition orientation, not clerical and not republican-left."
        ),
        "incompatible_with": [
            "iran_reformist_republican_bloc",
            "iran_ncri_ethnic_autonomist_bloc",
        ],
        "incompatibility_reason": (
            "Monarchy/constitutional-restoration vs. republican rejection; the republican left is "
            "explicitly anti-Pahlavi, and ethnic-autonomism conflicts with its centralist frame."
        ),
    },
    {
        "id": "iran_reformist_republican_bloc",
        "name": "Reformist / Republican / anti-war left (NIAC, National Front)",
        "type": "non_state",
        "support_rank": 2,  # second: real constituency, smaller than the Pahlavi base
        "agenda": (
            "Replace the Islamic Republic with a secular republic via internally-driven, "
            "non-restoration change; oppose externally-dependent restoration and foreign-led war."
        ),
        "why": (
            "Explicitly ANTI-monarchist / anti-Pahlavi: rejects an externally-dependent restoration "
            "and a foreign-imposed transition. Republican and reform-rooted (e.g. NIAC, National "
            "Front lineage), distinct from both the Pahlavi bloc and the NCRI/MEK."
        ),
        "incompatible_with": [
            "iran_pahlavi_constitutional_bloc",
            "iran_ncri_ethnic_autonomist_bloc",
        ],
        "incompatibility_reason": (
            "Anti-monarchist (rejects Pahlavi restoration) AND distinct from the NCRI/MEK, whose "
            "exile organization and contested record it does not share."
        ),
    },
    {
        "id": "iran_ncri_ethnic_autonomist_bloc",
        "name": "NCRI / PMOI-MEK (Maryam Rajavi) + PJAK + ethnic-minority autonomists",
        "type": "non_state",
        "support_rank": 3,  # LOWEST domestic legitimacy
        "agenda": (
            "Advance an exile-organized, externally-amplified path to power (NCRI/MEK provisional "
            "framework) alongside ethnic-minority autonomist claims (Kurd/Baluch/Azeri/Arab/Turkmen)."
        ),
        "why": (
            "Organizationally distinct and HIGHLY VISIBLE in diaspora media, but holds the LOWEST "
            "domestic legitimacy of the three currents. Includes NCRI/PMOI-MEK (Maryam Rajavi), "
            "PJAK, and ethnic-minority autonomists; ethnic-autonomism conflicts with the centralist "
            "secular opposition."
        ),
        "incompatible_with": [
            "iran_pahlavi_constitutional_bloc",
            "iran_reformist_republican_bloc",
        ],
        "incompatibility_reason": (
            "Lowest domestic legitimacy and the most polarizing; ethnic-autonomist claims clash with "
            "the centralist secular opposition, and the NCRI/MEK is rejected by both other currents."
        ),
    },
]

# Coalition rule (recorded so optimizers/readers can assert it): these three are mutually
# hostile and must NOT be coalesced into a single party.
COALITION_RULE: str = (
    "The three opposition blocs are mutually incompatible and must NOT be merged into one "
    "party. Weight them by realistic domestic popular support: "
    "Pahlavi >> reformist/republican > MEK/NCRI."
)

# What the naive run actually produced (the BEFORE), referenced for the documented delta and
# usable as the negative side of a discovery training Example. ids/types/weights are the
# verbatim values from discovery_output.json (run-v1).
NAIVE_BEFORE: dict[str, Any] = {
    "scattered_single_parties": [
        {"id": "reza_pahlavi_network", "type": "diaspora_network", "weight": 4},
        {"id": "ncri_pmoi_mek_under_maryam_raj", "type": "opposition_group", "weight": 3},
        {"id": "pjak", "type": "militia", "weight": 4},
    ],
    "missing_blocs": [
        "Reformist / Republican / anti-war left (NIAC, National Front) — absent entirely",
    ],
    "failures": [
        "FLATTEN/SCATTER: rival opposition currents discovered as unrelated single parties "
        "with no signal that they are mutually incompatible and cannot coalesce.",
        "MISSING BLOC: no reformist/republican/anti-war-left current at all.",
        "MIS-WEIGHT: weighted by organizational visibility / diaspora-media presence, not "
        "domestic popular support — Reza Pahlavi's largest domestic base (own evidence cited "
        "GAMAAN 31%) buried at weight 4, below regime and external-state actors.",
    ],
}

# The packaged gold case (BEFORE + corrected blocs + the rules + the general principle).
IRI_OPPOSITION_GOLD: dict[str, Any] = {
    "topic_id": "iri-regime-collapse-and-formation-of-a-new-iranian-state-mnnfahns",
    "topic": "IRI regime collapse and formation of a new Iranian state",
    "principle": DISCOVERY_GUIDANCE,
    "naive_before": NAIVE_BEFORE,
    "corrected_blocs": GOLD_OPPOSITION_BLOCS,
    "coalition_rule": COALITION_RULE,
}

__all__ = [
    "DISCOVERY_GUIDANCE",
    "get_discovery_guidance",
    "GOLD_OPPOSITION_BLOCS",
    "COALITION_RULE",
    "NAIVE_BEFORE",
    "IRI_OPPOSITION_GOLD",
]

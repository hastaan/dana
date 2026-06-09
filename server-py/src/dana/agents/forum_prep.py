"""Forum prep (⇄ TS WeightCalculator + representative generation).

Two DSPy calls (batched over all parties to keep it fast):
1. AssessWeights — the 5-factor influence model (military_capacity, economic_control,
   information_control, international_support, internal_legitimacy), each 0–100, grounded in
   the evidence, with a one-line justification per party. Final weight = normalized geometric
   pentagon AREA of the 5 factors (TS computePentagonScore) — a single spiked axis cannot inflate
   it; balanced strength scores higher.
2. GenerateRepresentatives — a debate persona (title + system prompt) per party.

Speaking budgets are derived in pure Python from each party's weight share (low-weight
parties still get a minimum floor so every voice is heard).
"""
import math

import dspy
from pydantic import BaseModel, Field

from ..research.gold import get_discovery_guidance

FACTORS = ("military_capacity", "economic_control", "information_control",
           "international_support", "internal_legitimacy")
LOW_WEIGHT_FLOOR = 150


class PartyWeight(BaseModel):
    party_id: str
    military_capacity: int = Field(ge=0, le=100)
    economic_control: int = Field(ge=0, le=100)
    information_control: int = Field(ge=0, le=100)
    international_support: int = Field(ge=0, le=100)
    internal_legitimacy: int = Field(ge=0, le=100)
    justification: str = Field(default="", description="1 sentence on the dominant factors")
    means: list[str] = Field(default_factory=list, description="specific levers of power / real capabilities this party has, grounded in the evidence")
    vulnerabilities: list[str] = Field(default_factory=list, description="specific weak points / constraints from the evidence")
    circle_visible: list[str] = Field(default_factory=list, description="known PUBLIC allies / key figures / institutions backing this party, each with brief context")
    circle_shadow: list[str] = Field(default_factory=list, description="inferred or COVERT backers / proxies / sponsors of this party, each with brief context")


class RepDraft(BaseModel):
    party_id: str
    persona_title: str = Field(description="honorific/role, e.g. 'IRGC Senior Commander'")
    persona_prompt: str = Field(description="<=120 word system prompt voicing this party in debate")


class AssessWeights(dspy.Signature):
    """Score each party's influence over the outcome on five 0-100 factors, grounded in the
    evidence, AND profile each party. Be discriminating - not everyone is a 70. A party with
    little military reach but strong information control should show that asymmetry. For each
    party also list its `means` (specific levers of power / real capabilities named in the
    evidence) and `vulnerabilities` (specific weak points / constraints from the evidence);
    do NOT invent capabilities the evidence does not support. One-sentence justification each.
    Also map each party's `circle`: circle_visible = its known public allies/key figures/
    institutions; circle_shadow = inferred or covert backers/proxies/sponsors (brief context
    each, grounded in the evidence; leave empty rather than invent).

    For a party of type='alliance' (its members are listed after 'members:' in the parties
    input): score the COMBINED capability of all listed members on each axis (combined military
    capacity, combined economic weight, etc.), set internal_legitimacy to the cohesion/unity of
    the bloc, and union the members' means and vulnerabilities."""

    topic: str = dspy.InputField()
    parties: str = dspy.InputField(desc="id, name, type, agenda; alliance rows also list 'members: ...'")
    evidence: str = dspy.InputField()
    weights: list[PartyWeight] = dspy.OutputField()


AssessWeights.__doc__ += ("\n\n    GOLD LESSON (internal_legitimacy discipline): " + get_discovery_guidance())


class GenerateRepresentatives(dspy.Signature):
    """Create one debate representative per party: a persona_title (their role/honorific) and a
    concise persona_prompt that will make the model argue authentically FOR that party's
    interests in a multi-party forum — its agenda, red lines, and rhetorical style. Stay in
    character; argue from interests, not neutrality."""

    topic: str = dspy.InputField()
    parties: str = dspy.InputField(desc="id, name, type, agenda")
    representatives: list[RepDraft] = dspy.OutputField()


_SIN72 = math.sin(2 * math.pi / 5)  # pentagon constant; cancels in normalization, kept for clarity


def pentagon_weight(factors: dict) -> float:
    """Overall party weight = normalized geometric AREA of the radar pentagon of the 5 axes
    (⇄ TS PartyScorer.computePentagonScore). Each axis contributes only via PRODUCTS with its two
    neighbours (axis ORDER = FACTORS), so a single spiked axis flanked by low axes adds ~nothing.
    area constant 0.5*_SIN72 cancels in area/maxArea; kept 1-dp to match server-py convention."""
    s = [max(0.0, min(100.0, float(factors.get(f, 0) or 0))) for f in FACTORS]
    adj = sum(s[i] * s[(i + 1) % 5] for i in range(5))
    max_adj = 5 * 100 * 100
    return round(100 * adj / max_adj, 1)


def final_weight(pw: PartyWeight) -> float:
    """Pentagon-area weight for a PartyWeight model (thin adapter over pentagon_weight)."""
    return pentagon_weight({f: getattr(pw, f) for f in FACTORS})


def speaking_budget(weight: float, total_weight: float) -> dict:
    ratio = (weight / total_weight) if total_weight > 0 else 0.0
    return {
        "opening_statement": max(LOW_WEIGHT_FLOOR, round(ratio * 600)),
        "rebuttal": max(LOW_WEIGHT_FLOOR, round(ratio * 400)),
        "closing": max(LOW_WEIGHT_FLOOR, round(ratio * 300)),
        "minimum_floor": LOW_WEIGHT_FLOOR,
    }


class ForumPrep(dspy.Module):
    def __init__(self):
        self.assess = dspy.ChainOfThought(AssessWeights)
        self.reps = dspy.ChainOfThought(GenerateRepresentatives)

    def forward(self, topic: str, parties_str: str, evidence_str: str):
        weights = self.assess(topic=topic, parties=parties_str, evidence=evidence_str).weights
        reps = self.reps(topic=topic, parties=parties_str).representatives
        return dspy.Prediction(weights=weights, representatives=reps)

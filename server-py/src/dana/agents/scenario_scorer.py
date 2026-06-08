"""Scenario synthesis + scoring (⇄ TS ForumOrchestrator scenario synthesis + ScenarioScorer).

Phase 2 "forum-lite": derive candidate scenarios from the parties' positions + the evidence,
then score them into a probability-ranked verdict carrying the Enh-4 rigor fields (base rate,
resolution criteria). The full multi-turn adversarial debate (chairman + representative turns)
is a later refinement; this already produces the user-visible verdict end-to-end.

Probabilities are normalized in pure Python (never trust the LLM to sum to 1.0).
"""
from typing import Literal

import dspy
from pydantic import BaseModel, Field


class ScenarioDraft(BaseModel):
    id: str = Field(description="short slug id, e.g. scenario-a")
    title: str
    description: str = ""
    supporting_parties: list[str] = Field(default_factory=list)


class RankedScenario(BaseModel):
    scenario_id: str
    title: str
    probability: float = Field(ge=0.0, le=1.0)
    confidence: Literal["high", "medium", "low"] = "medium"
    base_rate: float = Field(default=0.0, ge=0.0, le=1.0, description="reference-class prior")
    base_rate_reasoning: str = ""
    resolution_criteria: str = Field(default="", description="objective, checkable condition")
    resolution_date: str = Field(default="", description="ISO date / horizon")
    key_drivers: list[str] = Field(default_factory=list)
    watch_indicators: list[str] = Field(default_factory=list, description="observable signals that would move this probability")
    evidence_chain: str = ""


class GenerateScenarios(dspy.Signature):
    """Given the geopolitical topic, the parties (with agendas), and the gathered evidence,
    enumerate 3-6 DISTINCT, mutually-exclusive candidate outcome scenarios that could
    resolve the question. Each scenario gets a short slug id, a title, a one-sentence
    description, and which parties' interests it serves. Cover the plausible outcome space,
    not just the obvious one."""

    topic: str = dspy.InputField()
    parties: str = dspy.InputField(desc="parties with agendas")
    evidence: str = dspy.InputField(desc="key clues / findings")
    scenarios: list[ScenarioDraft] = dspy.OutputField()


class ScoreScenarios(dspy.Signature):
    """Objectively score each scenario's probability from the evidence. For each: set a
    reference-class base_rate (how often outcomes of this kind occur historically) and
    justify deviations; an objective, third-party-checkable resolution_criteria and a
    resolution_date; key_drivers; watch_indicators (observable signals to monitor); and a
    1-2 sentence evidence_chain citing the findings.
    Prefer scenarios backed by INDEPENDENT corroboration (see the independence note); a
    single source-cluster is weak. Give a final_assessment and a confidence_note. Do not
    invent evidence."""

    topic: str = dspy.InputField()
    scenarios: str = dspy.InputField()
    evidence: str = dspy.InputField(desc="findings + source-independence note")
    scenarios_ranked: list[RankedScenario] = dspy.OutputField()
    final_assessment: str = dspy.OutputField()
    confidence_note: str = dspy.OutputField()


class ScenarioScorer(dspy.Module):
    def __init__(self):
        self.generate = dspy.ChainOfThought(GenerateScenarios)
        self.score = dspy.ChainOfThought(ScoreScenarios)

    def forward(self, topic: str, parties_str: str, evidence_str: str):
        scen = self.generate(topic=topic, parties=parties_str, evidence=evidence_str).scenarios
        scen_str = "\n".join(f"- {s.id}: {s.title} — {s.description}" for s in scen) or "none"
        out = self.score(topic=topic, scenarios=scen_str, evidence=evidence_str)
        ranked = _normalize(out.scenarios_ranked)
        return dspy.Prediction(
            scenarios=scen,
            scenarios_ranked=ranked,
            final_assessment=out.final_assessment,
            confidence_note=out.confidence_note,
        )


def _normalize(ranked: list[RankedScenario]) -> list[RankedScenario]:
    total = sum(max(0.0, r.probability) for r in ranked)
    if total <= 0:
        n = len(ranked) or 1
        for r in ranked:
            r.probability = round(1.0 / n, 3)
    elif abs(total - 1.0) > 0.01:
        for r in ranked:
            r.probability = round(max(0.0, r.probability) / total, 3)
    return sorted(ranked, key=lambda r: r.probability, reverse=True)

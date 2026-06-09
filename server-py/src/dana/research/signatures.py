"""DSPy signatures + typed outputs for the STORM research engine.

Typed Pydantic OutputFields replace the TS backend's JSON-regex parsing: the DSPy adapter
coerces/validates these, with retries, instead of `JSON.parse(raw.match(/\\{...\\}/))`.
"""
from typing import Literal

import dspy
from pydantic import BaseModel, Field

PartyType = Literal["state", "state_military", "non_state", "individual", "media", "economic", "alliance"]


class PartyDraft(BaseModel):
    name: str
    type: PartyType = "non_state"
    agenda: str = Field(default="", description="what this actor wants")
    why: str = Field(default="", description="why this actor matters to the outcome")


class LensDraft(BaseModel):
    name: str = Field(description="short lens id, e.g. economic-leverage")
    focus: str = Field(description="what this analytical lens probes")


class ClueDraft(BaseModel):
    title: str
    summary: str = Field(description="bias-corrected 1-3 sentence finding")
    clue_type: Literal["fact", "event", "statement", "intelligence", "news"] = "event"
    relevance: int = Field(default=50, ge=0, le=100)
    credibility: int = Field(default=50, ge=0, le=100)
    key_points: list[str] = Field(default_factory=list)


class SurveyAnalogousCases(dspy.Signature):
    """Identify 3-6 historical or ongoing situations structurally analogous to this
    geopolitical scenario (similar actor configuration, stakes, or dynamics). For each:
    name, one line on why it is analogous, and the key parties/forces that mattered."""

    topic: str = dspy.InputField()
    description: str = dspy.InputField()
    today: str = dspy.InputField()
    analogues: str = dspy.OutputField(desc="numbered: name | why analogous | key actors")


class SeedPerspectives(dspy.Signature):
    """Given the scenario and analogous cases, produce the ADVERSARIAL party set and the
    cross-cutting analytical lenses for forecasting. Parties are real actors with
    conflicting agendas; lenses are frames (economic, military, info/legitimacy, external
    backing). Also give a short research outline: the top-level coverage sections.

    When several actors compete to lead, succeed, or replace a regime, distinguish rival
    opposition/successor factions that cannot coalesce: keep mutually-hostile currents as
    separate parties rather than merging or scattering them, and weight factions by
    realistic domestic popular support, not organizational visibility or diaspora-media
    presence."""

    topic: str = dspy.InputField()
    description: str = dspy.InputField()
    analogues: str = dspy.InputField()
    parties: list[PartyDraft] = dspy.OutputField()
    lenses: list[LensDraft] = dspy.OutputField()
    outline: list[str] = dspy.OutputField(desc="coverage sections to research")


class AskAsPersona(dspy.Signature):
    """You analyze a geopolitical scenario from the standpoint described in `persona`.
    You interview a grounded researcher to gather forecast-relevant evidence: capabilities,
    intentions, constraints, recent moves, and what would change the outcome. Ask ONE
    question at a time that PUBLIC REPORTING could plausibly answer (do not demand secret
    or exact-text details that wouldn't be reported). Build on the conversation; never
    repeat. Use coverage_gaps to pick under-covered areas. When you have enough, output
    exactly: NO_FURTHER_QUESTIONS"""

    topic: str = dspy.InputField()
    persona: str = dspy.InputField()
    conv: str = dspy.InputField(desc="conversation so far")
    coverage_gaps: str = dspy.InputField(desc="under-researched areas to prioritize")
    question: str = dspy.OutputField()


class QuestionToQueries(dspy.Signature):
    """Turn the question into 2-3 effective web search queries (one per line)."""

    topic: str = dspy.InputField()
    question: str = dspy.InputField()
    queries: list[str] = dspy.OutputField()


class GroundedAnswer(dspy.Signature):
    """You are a grounded researcher. Using the retrieved content below, answer the question
    as informatively as the content allows. Base every claim on the content and cite source
    numbers like [1], [2]. If the content is only partially relevant, give the most useful
    grounded answer you can from it and note what's still missing. Only if NOTHING in the
    content bears on the question, output exactly INSUFFICIENT_EVIDENCE. Do not invent
    specifics absent from the content; note source disagreement explicitly."""

    topic: str = dspy.InputField()
    question: str = dspy.InputField()
    info: str = dspy.InputField(desc="numbered retrieved sources with excerpts")
    answer: str = dspy.OutputField()


class DistillClues(dspy.Signature):
    """From a research conversation (questions + grounded answers + sources), distill the
    distinct, forecast-relevant CLUES. Each clue synthesizes related findings into one
    bias-corrected statement with verifiable key points. Only include clues supported by
    the gathered evidence; do not invent facts."""

    topic: str = dspy.InputField()
    persona: str = dspy.InputField()
    conversation: str = dspy.InputField()
    clues: list[ClueDraft] = dspy.OutputField()

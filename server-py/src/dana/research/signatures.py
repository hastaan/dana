"""DSPy signatures + typed outputs for the STORM research engine.

Typed Pydantic OutputFields replace the TS backend's JSON-regex parsing: the DSPy adapter
coerces/validates these, with retries, instead of `JSON.parse(raw.match(/\\{...\\}/))`.
"""
from typing import Literal

import dspy
from pydantic import BaseModel, Field

from .gold import get_discovery_guidance

PartyType = Literal["state", "state_military", "non_state", "individual", "media", "economic", "alliance"]


class PartyDraft(BaseModel):
    name: str
    type: PartyType = "non_state"
    agenda: str = Field(default="", description="what this actor wants")
    why: str = Field(default="", description="why this actor matters to the outcome")
    member_names: list[str] = Field(
        default_factory=list,
        description="ONLY for type='alliance': the names of the aligned member actors this "
        "coalition party groups together. Leave empty for single actors.",
    )


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
    """Given the scenario and analogous cases, produce the FULL adversarial party set and the
    cross-cutting analytical lenses for forecasting. Parties are real actors with conflicting
    agendas; lenses are frames (economic, military, info/legitimacy, external backing). Also
    give a short research outline: the top-level coverage sections.

    MANDATORY COVERAGE — think across ALL of these axes and ensure the party set spans them;
    do NOT return only internal/domestic actors:
      1. ECONOMIC — producers, markets, financial institutions, sanctions/funding levers.
      2. POLITICAL — governments, ruling factions, international bodies with policy levers.
      3. MILITARY / CONFLICT — armed forces, militias, state-military actors in active conflict.
      4. GEOPOLITICAL — EXTERNAL state actors and regional powers with a stake in the outcome
         (e.g. great powers, neighbouring states, sponsors). External players are MANDATORY:
         for any regime/conflict topic, identify the foreign states that back, oppose,
         sanction, arm, or pressure the parties — they almost always belong in the set.
      5. ADVERSARIAL — who opposes whom? who imposes sanctions, blockades, strikes, or
         pressure? Identify actors on BOTH/ALL opposing sides; adversarial parties are
         MANDATORY, not optional.

    GROUP INTO NAMED ALLIANCES — when 2+ actors share the SAME strategic goal on THIS topic
    and coordinate or align (formal bloc, treaty, joint policy, shared backing), emit them as
    a SINGLE party with type='alliance', a descriptive bloc name (e.g. "US-Israel
    Regime-Change Coalition", "Russia-China Sovereignty-Defender Bloc"), the joined agenda,
    and the member actors listed in `member_names`. Prefer grouping genuinely-aligned external
    blocs into one named coalition over scattering them as separate single states.

    BUT KEEP RIVALS SEPARATE (this OVERRIDES grouping): never coalesce actors that have
    DIVERGENT agendas on this topic. When several actors compete to lead, succeed, or replace
    a regime, distinguish rival opposition/successor factions that cannot coalesce: keep
    mutually-hostile currents as SEPARATE parties rather than merging or scattering them, and
    weight factions by realistic domestic popular support, not organizational visibility or
    diaspora-media presence. (Aligned external blocs and rival domestic factions are different
    actor sets — group the former, split the latter.)"""

    topic: str = dspy.InputField()
    description: str = dspy.InputField()
    analogues: str = dspy.InputField()
    parties: list[PartyDraft] = dspy.OutputField(
        desc="internal factions AND external state actors AND named type='alliance' coalitions"
    )
    lenses: list[LensDraft] = dspy.OutputField()
    outline: list[str] = dspy.OutputField(
        desc="coverage sections to research; MUST include a geopolitical/external-actor section "
        "and an adversarial/conflict (sanctions, strikes, rival-bloc) section"
    )


# Wire the LIVE gold lesson into the instruction (previously dead code outside the optimizer):
# append the rival-factions / realistic-popular-support principle so the runtime prompt and the
# trainset can't drift. This SUPPLEMENTS — does not replace — the external-axis mandate above.
SeedPerspectives.__doc__ += "\n\n    GOLD LESSON (rival-faction discipline): " + get_discovery_guidance()


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
    """Turn the question into 2-3 effective web search queries (one per line). The scenario is
    a CURRENT-EVENTS situation: when the question concerns recent or ongoing developments
    (who is acting/sanctioning/striking/aligning NOW), make at least one query target live
    reporting by appending the current year or a recency token (e.g. "2026", "latest",
    "recent"). Keep queries specific and diverse; avoid purely academic phrasings that only
    return papers."""

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


# ── Discovery refinement (ports the deleted TS prompts/discovery/refine-parties.md) ──
class AddOp(BaseModel):
    name: str
    type: PartyType = "non_state"
    reason: str = Field(description="cite the evidence that names this actor")


class GroupOp(BaseModel):
    alliance_name: str = Field(description="descriptive bloc name, e.g. 'US-Israel Coalition'")
    member_names: list[str] = Field(description="names of existing parties that form this bloc")
    reason: str = Field(description="why these act as one bloc on this topic, citing evidence")
    keep_separate: list[str] = Field(
        default_factory=list,
        description="member names to EXCLUDE because they have a divergent agenda on this topic",
    )


class DeleteOp(BaseModel):
    name: str
    reason: str = Field(description="why this actor has no agency/evidence on this topic")


class RefineParties(dspy.Signature):
    """You have a draft party list and the research evidence (clues) gathered for a
    geopolitical forecast. Consolidate the list so it is accurate, non-redundant, and
    strategically grouped. This is a single reasoning pass over ALREADY-gathered evidence — do
    NOT request new searches.

    Emit three kinds of decisions (any may be empty):

    ADD — add an actor that the evidence explicitly NAMES, that has clear agency over the
    outcome, and that is NOT already in the list. Crucially, ADD missed EXTERNAL state actors
    and regional powers (sponsors, sanctioners, military backers, opposing-side states) that
    the evidence surfaces but the draft omitted — internal-only lists are a known failure mode.
    Do NOT add speculative actors absent from the evidence.

    GROUP INTO ALLIANCE — create a named coalition from 2+ existing parties that share the
    SAME strategic goal on THIS topic and coordinate/align their actions (formal bloc, treaty,
    joint policy, shared backing). Give it a descriptive bloc name (e.g. "US-Israel
    Regime-Change Coalition", "Russia-China Sovereignty-Defender Bloc"), list members in
    member_names, and cite the evidence. Prefer grouping genuinely-aligned blocs over leaving
    them scattered. Put a member in keep_separate ONLY if it has a divergent agenda on this
    topic.

    DELETE — only remove an actor the evidence shows has no agency or involvement. Do NOT
    delete an actor merely because it is weak — minor actors with agency still matter.

    HARD RULE (gold discipline) — NEVER group rival opposition/successor factions that cannot
    coalesce (e.g. mutually-hostile domestic blocs competing to replace the same regime). They
    have divergent agendas and MUST stay separate, even if superficially "anti-regime". Group
    only genuinely-aligned actors (typically external blocs); keep rivals apart."""

    topic: str = dspy.InputField()
    parties: str = dspy.InputField(desc="current draft parties: name (type) — agenda")
    evidence: str = dspy.InputField(desc="distilled clues gathered during research")
    add: list[AddOp] = dspy.OutputField()
    group: list[GroupOp] = dspy.OutputField()
    remove: list[DeleteOp] = dspy.OutputField(desc="actors with no agency/evidence to drop")


class GroundingAngles(dspy.Signature):
    """List distinct, non-overlapping investigative angles to ground a geopolitical forecast in
    CURRENT real-world reporting. Today's date is provided — treat the subject as a live,
    ongoing situation. The angles MUST collectively cover, at minimum: (a) the internal/domestic
    factions and who would replace or lead; (b) EXTERNAL state actors and regional powers
    (great powers, neighbours, sponsors) backing or opposing the parties; (c) the ADVERSARIAL /
    conflict dimension — active sanctions, blockades, strikes, proxy war, and rival blocs; (d)
    economic actors and leverage. Do NOT return only internal-succession angles. One short
    phrase each."""

    subject: str = dspy.InputField()
    today: str = dspy.InputField()
    n: int = dspy.InputField(desc="how many angles")
    angles: list[str] = dspy.OutputField()

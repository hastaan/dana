"""Delta-update intelligence (⇄ deleted TS agents/DeltaRepresentativeAgent.ts +
prompts/delta-representative/system.md + prompts/forum/delta-scenario-impact.md).

When new/updated clues arrive after a complete analysis, the delta pipeline re-asks each
representative how the change affects their position (a per-rep "position update" turn) and
synthesizes how each prior scenario is impacted — far cheaper than re-running the whole forum.

BOUNDED port: each rep makes ONE typed DSPy call (no agentic loop); typed Pydantic outputs
replace the TS JSON-regex salvage. Sync — run inside asyncio.to_thread under lm_context.
"""
from typing import Literal

import dspy
from pydantic import BaseModel, Field


class DeltaPosition(BaseModel):
    """⇄ delta-representative/system.md OUTPUT FORMAT."""
    prior_position_summary: str = Field(default="", description="1-2 sentence summary of the rep's prior position")
    updated_position: str = Field(default="", description="updated position statement, <200 words, cite clue ids [clue-xxx]")
    position_delta: Literal["upgraded", "downgraded", "unchanged", "new_argument"] = "unchanged"
    clues_cited: list[str] = Field(default_factory=list)


class DeltaRepresentative(dspy.Signature):
    """You are a forum representative providing a position update based on new evidence.

    You previously argued for your party. New clues have emerged. Your task:
    1. Summarize your prior position in 1-2 sentences.
    2. Assess how the new clues affect your party's position.
    3. Write an updated position statement (<200 words) that references your prior position and
       explains what changed, citing new/updated clues by id [clue-xxx].
    4. Classify the change: upgraded (stronger), downgraded (weaker), unchanged, or new_argument.

    Be honest about whether the new evidence helps or hurts your party — do not pretend a
    weakening is a strengthening. Stay in character for your party's interests."""
    persona: str = dspy.InputField(desc="the representative's persona/system prompt")
    party_name: str = dspy.InputField()
    agenda: str = dspy.InputField()
    change_narrative: str = dspy.InputField(desc="what changed (the delta summary)")
    new_clues: str = dspy.InputField(desc="full detail of the new/updated clues")
    prior_statements: str = dspy.InputField(desc="this rep's prior forum statements")
    update: DeltaPosition = dspy.OutputField()


class ScenarioImpact(BaseModel):
    scenario_id: str
    update_type: Literal["strengthened", "weakened", "unchanged", "new"] = "unchanged"
    reason: str = ""


class DeltaScenarioImpact(dspy.Signature):
    """You synthesize forum position updates into scenario impact assessments. Given the delta
    context and each representative's position update, determine how each prior scenario is
    affected: strengthened, weakened, unchanged, or whether the change implies a new scenario.
    Output one impact per scenario, with a brief reason."""
    change_narrative: str = dspy.InputField(desc="what changed (the delta summary)")
    position_updates: str = dspy.InputField(desc="each rep's party_name, position_delta, and updated position")
    scenarios: str = dspy.InputField(desc="the prior scenarios (id + title)")
    impacts: list[ScenarioImpact] = dspy.OutputField()

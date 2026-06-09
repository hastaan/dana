"""Runtime instruction-override layer for the DSPy signatures (Lane A — the Python analogue
of the TS backend's editable `.md` prompt files).

server-py has NO `.md` prompt files: its "prompts" are the docstrings/`instructions` of the
DSPy Signature classes across `research/signatures.py`, `research/engine.py`,
`research/deep_search.py`, and `agents/*.py`. This module exposes those docstrings under
stable, editable NAMES (the REGISTRY) and lets an operator override them at runtime — exactly
what the frontend prompt editor (Settings → Prompts) drives via `api/prompts.py`.

Design (DEFAULT = byte-identical current behavior):
- At import we snapshot each signature's ORIGINAL `instructions` (its `__doc__`) into
  `_DEFAULTS`, so a reset restores the verbatim default no matter what we've mutated.
- `get_instructions(name)` returns the DB override if one is set, else that default.
- `apply_overrides()` (called from `dspy_lm.configure`, the single chokepoint every DSPy
  module is built behind) mutates each signature class's `.instructions` IN PLACE: to the
  override when present, else back to the captured default. DSPy modules are constructed
  AFTER `configure()` in every pipeline stage, so they pick up the mutated instructions.
  With an EMPTY override store this restores every signature to its default → a no-op.

The override TEXT is persisted in `prompt_overrides`; model/tools live in `prompt_configs`
(the table the TS backend already created). See db/writers.py + db/reads.py.
"""
from __future__ import annotations

import re

import dspy

from ..agents.forum import FrameDebate, SpeakTurn, SynthesizeDebate
from ..agents.forum_prep import AssessWeights, GenerateRepresentatives
from ..agents.scenario_scorer import GenerateScenarios, ScoreScenarios
from ..db import reads
from ..research.deep_search import NextQuestion, ResearchAngles, SynthesizeBriefing
from ..research.signatures import (
    AskAsPersona,
    DistillClues,
    GroundedAnswer,
    QuestionToQueries,
    SeedPerspectives,
    SurveyAnalogousCases,
)

# ── Registry: stable NAME → DSPy Signature class ────────────────────────────────
# Names are "stage/slug" (mirrors the TS prompt-name convention, e.g. "discovery/orient").
# These are the editable prompts surfaced to the frontend; the slug is stable (renaming it
# orphans any saved override), the docstring is the default content.
REGISTRY: dict[str, type[dspy.Signature]] = {
    # Discovery (STORM research engine)
    "discovery/survey_analogues": SurveyAnalogousCases,
    "discovery/seed_perspectives": SeedPerspectives,
    "discovery/ask_as_persona": AskAsPersona,
    "discovery/question_to_queries": QuestionToQueries,
    "discovery/grounded_answer": GroundedAnswer,
    "discovery/distill_clues": DistillClues,
    # Deep search (multi-angle grounded briefing)
    "deep_search/research_angles": ResearchAngles,
    "deep_search/next_question": NextQuestion,
    "deep_search/synthesize_briefing": SynthesizeBriefing,
    # Forum prep (weights + representatives)
    "forum/assess_weights": AssessWeights,
    "forum/generate_representatives": GenerateRepresentatives,
    # Forum debate
    "forum/frame_debate": FrameDebate,
    "forum/representative_turn": SpeakTurn,
    "forum/synthesize_debate": SynthesizeDebate,
    # Scenario scoring (verdict)
    "scoring/generate_scenarios": GenerateScenarios,
    "scoring/score_scenarios": ScoreScenarios,
}

# Default task profile per prompt (⇄ TS BUILTIN_DEFAULTS.task_profile) — purely advisory
# metadata the frontend uses to label the model auto-selection; does not affect behavior.
TASK_PROFILE: dict[str, str] = {
    "discovery/survey_analogues": "balanced",
    "discovery/seed_perspectives": "balanced",
    "discovery/ask_as_persona": "fast",
    "discovery/question_to_queries": "fast",
    "discovery/grounded_answer": "balanced",
    "discovery/distill_clues": "balanced",
    "deep_search/research_angles": "fast",
    "deep_search/next_question": "fast",
    "deep_search/synthesize_briefing": "deep_reasoning",
    "forum/assess_weights": "balanced",
    "forum/generate_representatives": "balanced",
    "forum/frame_debate": "deep_reasoning",
    "forum/representative_turn": "deep_reasoning",
    "forum/synthesize_debate": "deep_reasoning",
    "scoring/generate_scenarios": "deep_reasoning",
    "scoring/score_scenarios": "deep_reasoning",
}

# Snapshot the verbatim default instructions at import (before any override mutation), so a
# reset is byte-identical to the shipped signature docstring.
_DEFAULTS: dict[str, str] = {name: (sig.instructions or "") for name, sig in REGISTRY.items()}


def is_registered(name: str) -> bool:
    return name in REGISTRY


def names() -> list[str]:
    return list(REGISTRY.keys())


def default_instructions(name: str) -> str:
    """The shipped (default) instructions for a prompt — its signature's original docstring."""
    return _DEFAULTS.get(name, "")


def get_instructions(name: str) -> str:
    """The EFFECTIVE instructions for a prompt: the DB override when set, else the default.

    The single source of truth for "what text is this prompt right now" — used by both the
    router (to render current content) and apply_overrides (to decide what to install)."""
    override = reads.get_prompt_instructions(name)
    if override is not None:
        return override
    return _DEFAULTS.get(name, "")


def variables(content: str) -> list[str]:
    """`{placeholder}` tokens in the content (⇄ TS variablesFromContent). DSPy signatures use
    named InputFields, not `{}` templating, so this is usually empty — kept for contract parity
    and to surface any literal braces an operator adds to an override."""
    found = set(re.findall(r"\{([a-zA-Z_][a-zA-Z0-9_]*)\}", content))
    return sorted(found)


def apply_overrides() -> int:
    """Install the effective instructions onto every registered signature class IN PLACE, so
    DSPy modules constructed afterward use them. For each prompt: set `.instructions` to the DB
    override if present, else RESTORE the captured default (so removing an override reverts a
    previously-mutated class). Returns the count of prompts that have an active override.

    No-op semantics: with an empty override store every signature is set back to its default,
    i.e. behavior is byte-identical to never having called this. Safe to call every configure().
    """
    overrides = reads.all_prompt_overrides()
    for name, sig in REGISTRY.items():
        text = overrides.get(name)
        sig.instructions = text if text is not None else _DEFAULTS.get(name, "")
    return len(overrides)

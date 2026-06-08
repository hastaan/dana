"""Multi-party forum debate (⇄ TS ForumOrchestrator + ForumSupervisor + RepresentativeAgent).

A moderator frames the central question and the points of contention; then each party's
representative speaks IN CHARACTER across three phases — opening_statements → rebuttal →
closing (with a scenario endorsement) — grounded in the gathered clues. A synthesis step
writes the debate summary. The orchestration (rounds, persistence, SSE, scenario
aggregation) lives in pipeline/forum.py; this module is the typed DSPy layer.
"""
import dspy
from pydantic import BaseModel, Field


class EvidenceItem(BaseModel):
    claim: str
    clue_id: str = ""
    interpretation: str = ""


class ChallengeItem(BaseModel):
    target_party: str
    challenge: str
    clue_id: str = ""


class FrameDebate(dspy.Signature):
    """As an impartial moderator, frame this forum: state the single central question the
    parties must resolve, and 2–4 concrete points of contention they genuinely disagree on.
    Be specific to the evidence — not generic."""

    topic: str = dspy.InputField()
    parties: str = dspy.InputField(desc="the parties and their agendas")
    evidence: str = dspy.InputField()
    central_question: str = dspy.OutputField()
    points_of_contention: list[str] = dspy.OutputField()


class SpeakTurn(dspy.Signature):
    """You ARE this party's representative in a multi-party geopolitical forum. Argue for YOUR
    party's interests in character — never neutral. Ground every claim in the cited clues
    (clue ids). In a rebuttal, directly challenge other parties' positions by name. Concede a
    point only when the evidence forces it. In a closing, endorse the single outcome scenario
    that best serves your party. Do not invent evidence."""

    topic: str = dspy.InputField()
    persona: str = dspy.InputField(desc="your persona prompt + agenda")
    phase: str = dspy.InputField(desc="opening_statements | rebuttal | closing")
    directive: str = dspy.InputField(desc="the moderator's focus for this turn")
    recent_turns: str = dspy.InputField(desc="what others just said (empty in the opening)")
    evidence: str = dspy.InputField(desc="available clues with ids")
    statement: str = dspy.OutputField(desc="your argument, in character")
    position: str = dspy.OutputField(desc="one line: the stance you are taking")
    evidence_cited: list[EvidenceItem] = dspy.OutputField()
    challenges: list[ChallengeItem] = dspy.OutputField()
    concessions: list[str] = dspy.OutputField()
    scenario_endorsement: str = dspy.OutputField(desc="the outcome you back (esp. in closing)")
    clues_cited: list[str] = dspy.OutputField(desc="clue ids you relied on")


class SynthesizeDebate(dspy.Signature):
    """Impartially synthesize the forum: the central fault lines, where parties clashed, which
    clues were contested vs. agreed, and the distinct outcome scenarios that emerged with who
    backs each. 3–5 paragraphs. Do not pick a winner — that is the scorer's job."""

    topic: str = dspy.InputField()
    transcript: str = dspy.InputField()
    debate_summary: str = dspy.OutputField()


class Moderator(dspy.Module):
    def __init__(self):
        self.frame = dspy.ChainOfThought(FrameDebate)

    def forward(self, topic: str, parties: str, evidence: str):
        return self.frame(topic=topic, parties=parties, evidence=evidence)


class Representative(dspy.Module):
    def __init__(self):
        self.speak = dspy.ChainOfThought(SpeakTurn)

    def forward(self, **kw):
        return self.speak(**kw)


class Synthesizer(dspy.Module):
    def __init__(self):
        self.synth = dspy.ChainOfThought(SynthesizeDebate)

    def forward(self, topic: str, transcript: str):
        return self.synth(topic=topic, transcript=transcript)

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


# ── Moderated-debate layer (⇄ TS ForumSupervisor.moderate + prompts/forum/supervisor-moderate.md) ──
class ModerateDecision(BaseModel):
    next_speaker: str = Field(default="", description="party_id of the next speaker, or '' when closing")
    reason: str = Field(default="", description="1 sentence: why this party speaks next / why to close")
    directive: str = Field(default="", description="optional 1-sentence natural moderator nudge")
    should_close: bool = False
    coverage_score: int = Field(default=50, ge=0, le=100)


class ModerateTurn(dspy.Signature):
    """You are the impartial moderator of a high-stakes geopolitical forum. You control who speaks
    next and when the debate ends. Decide the next action by following these rules IN ORDER OF
    PRIORITY:

    1. SILENT PARTIES FIRST — if any party is listed in silent_parties, they MUST speak before any
       party that spoke in the last 5 turns gets the floor again (highest priority after the opening).
    2. EXCHANGE LIMITS — if two parties have been exchanging for 2 consecutive turns (see
       recent_speakers), give the floor to someone else and direct them to wrap up; only allow a third
       consecutive exchange for a critical factual dispute that must be resolved now.
    3. CONVERSATIONAL FLOW — a party just challenged or called out by name may respond, but only if it
       did not already respond in the previous turn. Natural debates have back-and-forth, but moderated
       debates also have breadth.
    4. PARTICIPATION BALANCE — check the turns/expected ratio in parties_list; parties far below their
       expected turns get priority. Parties already at/above their expected turns speak only if directly
       challenged.
    5. CLOSURE — set should_close=true (and next_speaker='') ONLY when ALL are true: at least min_turns
       turns completed; at least 2 distinct scenarios developed; all parties with priority > 10% spoke
       at least twice; the last 5+ turns show diminishing returns (recycling arguments, no new evidence).
       As the debate approaches soft_ceiling turns, actively steer parties toward concluding positions;
       if budget_warning is WRAP-UP / OVER / FINAL you should close unless a genuinely critical argument
       is unresolved.

    next_speaker MUST be a party_id present in parties_list (or '' when should_close=true). If you
    provide a directive, make it a natural one-sentence moderator statement (e.g. "Let's move on from
    this exchange and hear from the regulatory side"); during wrap-up, guide parties to state their
    final position concisely. coverage_score (0-100) estimates how thoroughly the question is covered."""

    topic: str = dspy.InputField()
    parties_list: str = dspy.InputField(desc="one line per party: id (priority=%, turns=count/expected)")
    turn_distribution: str = dspy.InputField(desc="id: N turns, ... so far")
    recent_speakers: str = dspy.InputField(desc="last few speakers as 'a -> b -> c'")
    silent_parties: str = dspy.InputField(desc="parties that haven't spoken recently (may be empty)")
    budget_warning: str = dspy.InputField(desc="WRAP-UP / OVER / FINAL warning, or empty")
    scenarios_summary: str = dspy.InputField(desc="distinct scenarios on the table so far")
    last_turn: str = dspy.InputField(desc="the most recent statement (truncated), or first-turn note")
    turn_number: int = dspy.InputField()
    soft_ceiling: int = dspy.InputField(desc="expected length; begin wrap-up around here")
    hard_limit: int = dspy.InputField(desc="debate ends regardless at this many turns")
    min_turns: int = dspy.InputField(desc="minimum turns before closure is allowed")
    decision: ModerateDecision = dspy.OutputField()


class Supervisor(dspy.Module):
    def __init__(self):
        self.moderate = dspy.ChainOfThought(ModerateTurn)

    def forward(self, **kw):
        return self.moderate(**kw).decision

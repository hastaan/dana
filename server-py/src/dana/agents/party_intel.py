"""Party-management intelligence (⇄ deleted TS agents/PartyIntelligence.ts + prompts/party-intelligence/*.md).

Small, NON-search DSPy signatures port the deleted add/edit/merge/split prompts; weight is NOT
produced here (the prompts forbid it) — every route re-derives it via rescore_party (AssessWeights
+ final_weight). Sync; run inside asyncio.to_thread under dspy_lm.lm_context().
"""
from typing import Callable

import dspy
from pydantic import BaseModel, Field

from ..llm.controls import control
from ..research.gather import gather_research
from ..research.gold import get_discovery_guidance
from ..research.signatures import PartyType
from .forum_prep import FACTORS, AssessWeights, final_weight, pentagon_weight

Emit = Callable[[dict], None]


class Circle(BaseModel):
    visible: list[str] = Field(default_factory=list, description="known public allies / key figures / institutions, each with brief context")
    shadow: list[str] = Field(default_factory=list, description="inferred or covert backers / proxies, each with brief context")


class PartyProfile(BaseModel):
    """Mirrors the party-intelligence prompt JSON schema. NO weight/weight_factors (scored separately)."""
    name: str
    type: PartyType = "non_state"
    description: str = Field(default="", description="2-4 sentences with specific facts/dates/events")
    agenda: str = ""
    means: list[str] = Field(default_factory=list, description="levers of power / real capabilities")
    circle: Circle = Field(default_factory=Circle)
    stance: str = Field(default="active", description="one of: active | passive | covert | overt | defensive_active")
    vulnerabilities: list[str] = Field(default_factory=list)


class PartyQueries(dspy.Signature):  # port party-intelligence query-gen (add/edit research)
    """Generate targeted web-search queries to research a political/geopolitical party for a
    forecasting topic. Produce specific, fact-finding queries that surface the party's leadership,
    backers, capabilities, agenda, recent activity, and vulnerabilities — grounded in current,
    verifiable reporting."""
    topic: str = dspy.InputField()
    party_name: str = dspy.InputField()
    focus: str = dspy.InputField(desc="what to research (profile build, or user feedback to address)")
    queries: list[str] = dspy.OutputField(desc="3-5 search query strings")


class SmartAddParty(dspy.Signature):  # port add.md
    """Profile a single political/geopolitical party for a forecasting topic, grounded in the
    gathered research. Fill every field with specific, grounded detail: a 2-4 sentence description,
    its agenda, its means (levers of power), its circle (visible = known public allies/key figures/
    institutions; shadow = inferred or covert backers/proxies, each with brief context), stance, and
    vulnerabilities. Prefer specifics named in the research (people, institutions, dates) over
    generic claims; do NOT invent capabilities the research does not support. Do NOT output weight
    or weight_factors — those are computed separately by a dedicated scoring pipeline."""
    topic: str = dspy.InputField()
    description: str = dspy.InputField(desc="the topic description / context")
    party_name: str = dspy.InputField()
    existing_names: str = dspy.InputField(desc="names of parties already in the set (avoid duplicating)")
    research: str = dspy.InputField(desc="gathered web research about this party (may be empty)")
    profile: PartyProfile = dspy.OutputField()


class SmartEditParty(dspy.Signature):  # port edit.md
    """Given a party's current profile (JSON), user feedback, and freshly-gathered research, return
    an updated profile that addresses the feedback. Preserve accurate existing information; only
    change fields the feedback and research warrant. Ground new claims in the research (cite specific
    people/institutions/dates from it); do NOT invent unsupported detail. Keep circle.visible/
    circle.shadow populated. Do NOT output weight or weight_factors."""
    topic: str = dspy.InputField()
    current_party: str = dspy.InputField(desc="the party's current profile as JSON")
    feedback: str = dspy.InputField()
    research: str = dspy.InputField(desc="gathered web research (may be empty)")
    profile: PartyProfile = dspy.OutputField()


class SmartMergeParties(dspy.Signature):  # port merge.md — GOLD-GUARDED (optional path)
    """Multiple parties are being merged into one. Synthesize their profiles into a single coherent
    party profile. Combine means, circle members (visible + shadow), and vulnerabilities intelligently
    (deduplicate, merge related items). Write a new unified description and agenda. Do NOT output
    weight or weight_factors."""
    topic: str = dspy.InputField()
    sources: str = dspy.InputField(desc="the source party profiles as JSON")
    target_name: str = dspy.InputField()
    profile: PartyProfile = dspy.OutputField()


SmartMergeParties.__doc__ += ("\n\n    GOLD LESSON (do NOT coalesce rival currents): " + get_discovery_guidance())


class SmartSplitParty(dspy.Signature):  # port split.md
    """A party is being split into named sub-parties. Distribute the original party's attributes
    across the new parties: each gets the relevant subset of means, circle members, and
    vulnerabilities, with a specialized description and agenda. Return ONE profile per requested
    name, in order. Do NOT output weight or weight_factors."""
    topic: str = dspy.InputField()
    source_party: str = dspy.InputField(desc="the source party profile as JSON")
    into_names: list[str] = dspy.InputField(desc="the names of the sub-parties to create")
    parties: list[PartyProfile] = dspy.OutputField()


# ── Reusable single-party rescore (reuse AssessWeights/final_weight; mirrors engine._score_and_profile) ──
def _party_row(p: dict) -> str:
    base = f"- {p['id']} | {p['name']} ({p.get('type', '?')}): {p.get('agenda') or p.get('description') or '-'}"
    mem = (p.get('circle') or {}).get('visible') or []
    return base + (f"  members: {', '.join(mem)}" if p.get('type') == 'alliance' and mem else '')


def _party_evidence(p: dict) -> str:
    parts = [p.get('description', ''), p.get('agenda', '')]
    if p.get('means'):
        parts.append('Means: ' + '; '.join(p['means']))
    if (p.get('circle') or {}).get('visible'):
        parts.append('Allies: ' + '; '.join(p['circle']['visible']))
    if p.get('vulnerabilities'):
        parts.append('Vulnerabilities: ' + '; '.join(p['vulnerabilities']))
    return '\n'.join(x for x in parts if x) or '(no profile detail)'


def rescore_party(topic: str, description: str, party: dict) -> dict:
    """Re-run the 5-axis AssessWeights scorer over ONE party and return it with weight_factors/
    weight/weight_evidence (+ means/vulnerabilities if the scorer enriched them) set. Falls back
    to the FLOOR baseline (all-20) on failure (mirrors engine._score_and_profile). Sync — call
    inside lm_context."""
    out = dict(party)
    try:
        score = dspy.ChainOfThought(AssessWeights)
        ws = score(topic=f"{topic}\n\n{description}".strip(),
                   parties=_party_row(out), evidence=_party_evidence(out)).weights or []
        w = next((x for x in ws if (x.party_id == out['id'] or not x.party_id)), ws[0] if ws else None)
    except Exception:  # noqa: BLE001
        w = None
    if w is not None:
        out['weight_factors'] = {f: getattr(w, f) for f in FACTORS}
        out['weight'] = final_weight(w)
        out['weight_evidence'] = {f: (w.justification or '') for f in FACTORS}
        if w.means:
            out['means'] = list(dict.fromkeys(w.means))
        if w.vulnerabilities:
            out['vulnerabilities'] = list(dict.fromkeys(w.vulnerabilities))
    else:
        out['weight_factors'] = {f: 20 for f in FACTORS}
        out['weight'] = pentagon_weight(out['weight_factors'])
        out['weight_evidence'] = {f: 'Baseline estimate — not individually scored.' for f in FACTORS}
    return out


def recompute_weight(weight_factors: dict) -> float:
    """Pentagon-area weight of the 5 factors (NO LLM) — the PUT/update weight recompute, server-py's
    port of TS computePentagonScore. Single shared kernel (forum_prep.pentagon_weight)."""
    return pentagon_weight(weight_factors)


# ── Party research gathering (⇄ TS PartyIntelligence agentic web_search loop) ──────────
def _party_queries(topic: str, party_name: str, focus: str) -> list[str]:
    """Generate party-research queries (1 LLM call), with a deterministic fallback so the gather
    always has something to search even if query-gen fails."""
    try:
        qs = dspy.ChainOfThought(PartyQueries)(
            topic=topic, party_name=party_name, focus=focus).queries or []
    except Exception:  # noqa: BLE001
        qs = []
    qs = [q for q in qs if q and q.strip()]
    if not qs:
        base = f"{party_name} {topic}".strip()
        qs = [base, f"{party_name} leadership agenda allies", f"{party_name} {focus}".strip()]
    return qs


def gather_party_research(topic_id: str, topic: str, party_name: str, focus: str,
                          *, emit: Emit | None = None) -> str:
    """Bounded, corpus-aware, event-emitting research about a party (⇄ TS gatherResearch in the
    party add/edit flows). Query count + char budget honor analysis_controls.smart_edit_queries /
    smart_edit_max_chars. Sync — call inside lm_context in a worker thread. "" when search is
    unavailable (the caller's signature treats research as optional)."""
    qs = _party_queries(topic, party_name, focus)[: control("smart_edit_queries", 4)]
    return gather_research(
        topic_id, qs,
        max_queries=control("smart_edit_queries", 4),
        fetch_per=2, fetch_chars=2000,
        max_chars=control("smart_edit_max_chars", 12000),
        stage="discovery", emit=emit,
    )

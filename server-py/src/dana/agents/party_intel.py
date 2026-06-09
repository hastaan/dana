"""Party-management intelligence (⇄ deleted TS agents/PartyIntelligence.ts + prompts/party-intelligence/*.md).

Small, NON-search DSPy signatures port the deleted add/edit/merge/split prompts; weight is NOT
produced here (the prompts forbid it) — every route re-derives it via rescore_party (AssessWeights
+ final_weight). Sync; run inside asyncio.to_thread under dspy_lm.lm_context().
"""
import dspy
from pydantic import BaseModel, Field

from ..research.gold import get_discovery_guidance
from ..research.signatures import PartyType
from .forum_prep import FACTORS, AssessWeights, final_weight


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


class SmartAddParty(dspy.Signature):  # port add.md
    """Profile a single political/geopolitical party for a forecasting topic. Fill every field
    with specific, grounded detail: a 2-4 sentence description, its agenda, its means (levers of
    power), its circle (visible = known public allies/key figures/institutions; shadow = inferred
    or covert backers/proxies, each with brief context), stance, and vulnerabilities. Do NOT output
    weight or weight_factors — those are computed separately by a dedicated scoring pipeline."""
    topic: str = dspy.InputField()
    description: str = dspy.InputField(desc="the topic description / context")
    party_name: str = dspy.InputField()
    existing_names: str = dspy.InputField(desc="names of parties already in the set (avoid duplicating)")
    profile: PartyProfile = dspy.OutputField()


class SmartEditParty(dspy.Signature):  # port edit.md
    """Given a party's current profile (JSON) and user feedback, return an updated profile that
    addresses the feedback. Preserve accurate existing information; only change fields the feedback
    warrants. Keep circle.visible/circle.shadow populated. Do NOT output weight or weight_factors."""
    topic: str = dspy.InputField()
    current_party: str = dspy.InputField(desc="the party's current profile as JSON")
    feedback: str = dspy.InputField()
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
        out['weight'] = round(sum(out['weight_factors'].values()) / len(FACTORS), 1)
        out['weight_evidence'] = {f: 'Baseline estimate — not individually scored.' for f in FACTORS}
    return out


def recompute_weight(weight_factors: dict) -> float:
    """Pure-python mean of the 5 factors (NO LLM) — the PUT/update weight recompute, server-py's
    analogue of TS computePentagonScore (we use the mean, the rest of server-py's convention)."""
    return round(sum(int(weight_factors.get(f, 0) or 0) for f in FACTORS) / len(FACTORS), 1)

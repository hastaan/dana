"""Operator steering (⇄ TS llm/steering.ts).

AnalystGuidance lets an operator steer METHOD (framing, what to research, how to weigh
evidence, debate emphasis) — never the conclusion. Global guidance lives in app_settings;
a per-topic override (topics.settings.steering) wins. Blocks carry an explicit guardrail so
the model treats them as epistemic guidance, not an instruction to reach a preset answer.
"""
import json

from ..db import reads
from ..db import topics as topics_repo

SECTION_FIELD = {
    "framing": "framing_note",
    "research": "research_guidance",
    "evidence": "evidence_guidance",
    "debate": "debate_guidance",
}
GUARDRAIL = ("OPERATOR STEERING (guides METHOD, not the conclusion — defer to any evidence "
             "that contradicts it; never fabricate to satisfy it):")


async def effective_guidance(topic_id: str | None = None) -> dict:
    app = await reads.get_app_settings() or {}
    guidance = dict(app.get("steering") or {})
    if topic_id:
        topic = await topics_repo.get_topic(topic_id)
        tset = topic.get("settings") if topic else None
        if isinstance(tset, str):
            try:
                tset = json.loads(tset)
            except Exception:  # noqa: BLE001
                tset = None
        if isinstance(tset, dict) and isinstance(tset.get("steering"), dict):
            guidance.update({k: v for k, v in tset["steering"].items() if v})
    return guidance


def block(guidance: dict, section: str) -> str:
    if not guidance:
        return ""
    parts = []
    framing = guidance.get("framing_note")
    if framing:
        parts.append(framing.strip())
    field = SECTION_FIELD.get(section)
    if field and field != "framing_note" and guidance.get(field):
        parts.append(guidance[field].strip())
    if not parts:
        return ""
    return f"\n\n{GUARDRAIL}\n" + "\n".join(parts) + "\n"


async def steering_for(topic_id: str | None, section: str) -> str:
    return block(await effective_guidance(topic_id), section)

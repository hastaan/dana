import asyncio
import json

import dspy
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..agents import party_intel
from ..db import reads
from ..db import topics as topics_repo
from ..db import writers
from ..events.bus import bus
from ..llm import dspy_lm

router = APIRouter()


class CreateTopic(BaseModel):
    title: str
    description: str = ""


class PartialTopicBody(BaseModel):
    model_config = {"extra": "ignore"}
    title: str | None = None
    description: str | None = None
    status: str | None = None
    models: dict[str, str] | None = None
    settings: dict | None = None


class AnalystGuidance(BaseModel):
    """Per-topic operator steering (guides METHOD, not the conclusion). All fields optional."""
    framing_note: str | None = None
    research_guidance: str | None = None
    evidence_guidance: str | None = None
    debate_guidance: str | None = None


class SteeringBody(BaseModel):
    steering: AnalystGuidance | None = None


# ── Party-management request bodies (⇄ frontend api/client.ts parties.*) ───────────
class PartyBody(BaseModel):
    model_config = {"extra": "allow"}  # accept arbitrary partial-Party fields (frontend sends Record<string,unknown>)


class MergeBody(BaseModel):
    source_ids: list[str]
    target: dict = {}


class SmartAddBody(BaseModel):
    name: str


class SmartEditBody(BaseModel):
    feedback: str


class SplitInto(BaseModel):
    name: str


class SplitBody(BaseModel):
    source_id: str
    into: list[SplitInto] = []


def _topic_settings(topic: dict) -> dict:
    """topics.settings may be a JSON string or a dict depending on the read path."""
    s = topic.get("settings") or {}
    if isinstance(s, str):
        try:
            s = json.loads(s or "{}")
        except Exception:  # noqa: BLE001
            s = {}
    return s if isinstance(s, dict) else {}


@router.get("/api/topics")
async def list_topics():
    return await topics_repo.list_topics()


@router.post("/api/topics")
async def create_topic(body: CreateTopic):
    return await asyncio.to_thread(writers.create_topic, body.title, body.description)


@router.put("/api/topics/{topic_id}")
async def update_topic(topic_id: str, body: PartialTopicBody):
    """Partial topic edit (⇄ TS PUT /:id → dbUpdateTopic). Only sent fields patch (exclude_unset
    mirrors t.Partial); ONE-LEVEL settings merge; models replaced wholesale; bumps updated_at."""
    patch = body.model_dump(exclude_unset=True)
    updated = await asyncio.to_thread(writers.update_topic, topic_id, patch)
    if updated is None:
        raise HTTPException(status_code=404, detail={"message": "Topic not found"})
    return updated


@router.get("/api/topics/{topic_id}")
async def get_topic(topic_id: str):
    topic = await topics_repo.get_topic(topic_id)
    if topic is None:
        raise HTTPException(status_code=404, detail={"message": "Topic not found"})
    return topic


@router.get("/api/topics/{topic_id}/states")
async def get_states(topic_id: str):
    """Version history for the version selector (⇄ TS GET /:id/states → getAllVersions).
    No 404 guard — unknown topic returns []."""
    return await reads.list_states(topic_id)


@router.delete("/api/topics/{topic_id}")
async def delete_topic(topic_id: str):
    """Delete a topic and all its data (Dashboard TopicCard delete)."""
    await asyncio.to_thread(writers.delete_topic, topic_id)
    return {"success": True}


# ── Per-topic operator steering (Save guidance — TopicView/VerdictPanel) ───────────
# Stored in topics.settings.steering; the pipeline reads it via llm/steering.steering_for().
@router.get("/api/topics/{topic_id}/steering")
async def get_steering(topic_id: str):
    topic = await topics_repo.get_topic(topic_id)
    if topic is None:
        raise HTTPException(status_code=404, detail={"message": "Topic not found"})
    return {"steering": _topic_settings(topic).get("steering") or {}}


@router.put("/api/topics/{topic_id}/steering")
async def put_steering(topic_id: str, body: SteeringBody):
    topic = await topics_repo.get_topic(topic_id)
    if topic is None:
        raise HTTPException(status_code=404, detail={"message": "Topic not found"})
    settings = _topic_settings(topic)
    guidance = body.steering.model_dump() if body.steering else {}
    # Keep only the non-empty guidance fields (so clearing a field removes it).
    settings["steering"] = {k: v for k, v in guidance.items() if v}
    await asyncio.to_thread(writers.set_topic_settings, topic_id, settings)
    return {"steering": settings["steering"]}


@router.get("/api/topics/{topic_id}/parties")
async def get_parties(topic_id: str, version: int | None = None):
    """Parties for a topic. With ?version=, serve that version's pinned parties_snapshot for a
    completed historical version (⇄ TS parties route ?version=); without it, the live parties."""
    if version is not None:
        return await reads.list_parties_at_version(topic_id, version)
    return await reads.list_parties(topic_id)


@router.delete("/api/topics/{topic_id}/parties/{party_id}")
async def delete_party(topic_id: str, party_id: str):
    """Delete one party (PartiesPanel card delete)."""
    await asyncio.to_thread(writers.delete_party, topic_id, party_id)
    return {"success": True}


# ── Party management (⇄ deleted TS routes/parties.ts + agents/PartyIntelligence.ts) ──
# Every route resolves the topic first (404 if missing). DSPy/DB work runs in asyncio.to_thread
# under dspy_lm.lm_context() (matching pipeline/discovery.py). Each returned party dict carries
# the full reads.list_parties key set so the frontend round-trips it unchanged.
async def _require_topic(topic_id: str) -> dict:
    topic = await topics_repo.get_topic(topic_id)
    if topic is None:
        raise HTTPException(status_code=404, detail={"message": "Topic not found"})
    return topic


def _dedup_union(sources: list[dict], key: str, sub: str | None = None) -> list[str]:
    """Order-preserving union of a list-valued field (or circle sub-list) across source parties."""
    out: list[str] = []
    for s in sources:
        vals = (s.get(key) or {}).get(sub) if sub else s.get(key)
        for v in (vals or []):
            if v not in out:
                out.append(v)
    return out


@router.put("/api/topics/{topic_id}/parties/{party_id}")
async def update_party(topic_id: str, party_id: str, body: PartyBody):
    """Update one party in place (PartiesPanel inline edit / save). NO LLM: merges the partial
    body over the existing party and recomputes weight as the pentagon area of weight_factors
    (TS computePentagonScore)."""
    await _require_topic(topic_id)
    existing = await asyncio.to_thread(writers.get_party, topic_id, party_id)
    if existing is None:
        raise HTTPException(status_code=404, detail={"message": "Party not found"})
    patch = body.model_dump()
    merged = {**existing, **patch, "id": existing["id"]}
    merged["weight"] = party_intel.recompute_weight(merged.get("weight_factors", {}))
    await asyncio.to_thread(writers.upsert_party, topic_id, merged)
    return merged


@router.post("/api/topics/{topic_id}/parties")
async def add_party(topic_id: str, body: PartyBody):
    """Add a party (PartiesPanel manual add). Builds a party from the body defaults, then runs a
    single non-search AssessWeights rescore so it lands with real weight/factors + circle keys."""
    topic = await _require_topic(topic_id)
    b = body.model_dump()
    name = (b.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail={"message": "name is required"})
    pid = b.get("id") or await asyncio.to_thread(writers.unique_party_id, topic_id, name)
    party = {
        **b,
        "id": pid, "name": name, "type": b.get("type", "non_state"),
        "description": b.get("description", ""), "agenda": b.get("agenda", ""),
        "means": b.get("means", []),
        "circle": b.get("circle", {"visible": [], "shadow": []}),
        "stance": b.get("stance", "passive"), "vulnerabilities": b.get("vulnerabilities", []),
        "weight_factors": b.get("weight_factors", {}), "weight": 0, "weight_evidence": {},
        "auto_discovered": False, "user_verified": True,
    }

    model = dspy_lm.model_for(topic_id, "data_gathering")

    def _work():
        with dspy_lm.lm_context(model):
            return party_intel.rescore_party(topic["title"], topic["description"], party)

    scored = await asyncio.to_thread(_work)
    await asyncio.to_thread(writers.upsert_party, topic_id, scored)
    return scored


def _manual_merge(sources: list[dict], tname: str, target: dict, target_id: str) -> dict:
    """Deterministic field union — the FALLBACK when LLM synthesis fails (⇄ TS merge route catch
    block). Concatenates description/agenda, dedups means/circle/vulnerabilities."""
    return {
        "id": target_id, "name": tname,
        "type": target.get("type") or sources[0]["type"],
        "description": " ".join(s.get("description", "") for s in sources).strip(),
        "agenda": "; ".join(a for s in sources if (a := s.get("agenda"))),
        "means": _dedup_union(sources, "means"),
        "circle": {
            "visible": _dedup_union(sources, "circle", "visible"),
            "shadow": _dedup_union(sources, "circle", "shadow"),
        },
        "stance": sources[0].get("stance", "active"),
        "vulnerabilities": _dedup_union(sources, "vulnerabilities"),
        "weight_factors": sources[0].get("weight_factors", {}), "weight": 0, "weight_evidence": {},
        "auto_discovered": False, "user_verified": True,
    }


@router.post("/api/topics/{topic_id}/parties/merge")
async def merge_parties(topic_id: str, body: MergeBody):
    """Merge >=2 parties into one (PartiesPanel merge — the user's chief complaint). LLM SYNTHESIS
    via party_intel.SmartMergeParties is the PRIMARY path (⇄ TS smartMergeParties, prompt
    party-intelligence/merge.md, GOLD-guarded against coalescing rival currents); the deterministic
    field union is only the FALLBACK on LLM failure. The merged party is rescored, the sources
    deleted, and the merged party persisted. Emits SSE think events so the activity feed shows
    progress (⇄ TS emitThink taxonomy the frontend renders)."""
    topic = await _require_topic(topic_id)
    if len(body.source_ids) < 2:
        raise HTTPException(status_code=400, detail={"message": "Need at least 2 source_ids to merge"})
    target = body.target or {}
    tname = (target.get("name") or "").strip()
    if not tname:
        raise HTTPException(status_code=400, detail={"message": "target.name is required"})
    sources = []
    for sid in body.source_ids:
        s = await asyncio.to_thread(writers.get_party, topic_id, sid)
        if s is not None:
            sources.append(s)
    if len(sources) < 2:
        raise HTTPException(status_code=400, detail={"message": "Not enough matching source parties"})
    target_id = target.get("id") or writers.slugify(tname)
    src_names = ", ".join(s.get("name", "?") for s in sources)
    bus.emit(topic_id, {"type": "think", "icon": "🔀", "label": f"Merging into {tname}", "detail": src_names[:100]})
    model = dspy_lm.model_for(topic_id, "data_gathering")

    def _work():
        with dspy_lm.lm_context(model):
            try:
                prof = dspy.ChainOfThought(party_intel.SmartMergeParties)(
                    topic=topic["title"], sources=json.dumps(sources), target_name=tname,
                ).profile
                merged = {**prof.model_dump(), "id": target_id, "name": prof.name or tname,
                          "type": target.get("type") or prof.type,
                          "weight": 0, "weight_factors": {}, "weight_evidence": {},
                          "auto_discovered": False, "user_verified": True}
            except Exception:  # noqa: BLE001 — LLM/parse failure -> deterministic union fallback
                merged = _manual_merge(sources, tname, target, target_id)
            return party_intel.rescore_party(topic["title"], topic["description"], merged)

    scored = await asyncio.to_thread(_work)
    scored["id"] = target_id  # re-force id after rescore (TS parity)
    # Delete every source THEN upsert merged — a source id may equal target_id when re-merging in
    # place, so delete first and upsert last.
    for sid in body.source_ids:
        if sid != target_id:
            await asyncio.to_thread(writers.delete_party, topic_id, sid)
    await asyncio.to_thread(writers.upsert_party, topic_id, scored)
    # Repoint clues from the (now-deleted) source parties to the merged party (⇄ TS dbReplaceClues).
    await asyncio.to_thread(writers.remap_party_in_clues, topic_id, body.source_ids, scored.get("id", target_id))
    bus.emit(topic_id, {"type": "think", "icon": "✅", "label": f"Merge complete: {scored.get('name', tname)}"})
    return scored


@router.post("/api/topics/{topic_id}/parties/smart-add")
async def smart_add_party(topic_id: str, body: SmartAddBody):
    """LLM-profile a party from just a name (PartiesPanel smart add), then rescore + persist."""
    topic = await _require_topic(topic_id)
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail={"message": "name is required"})
    existing = await reads.list_parties(topic_id)
    existing_names = ", ".join(p["name"] for p in existing)
    bus.emit(topic_id, {"type": "think", "icon": "➕", "label": f"Smart add: {name}"})
    model = dspy_lm.model_for(topic_id, "data_gathering")

    def _work():
        with dspy_lm.lm_context(model):
            research = party_intel.gather_party_research(
                topic_id, topic["title"], name, "build a full profile",
                emit=lambda e: bus.emit(topic_id, e))
            bus.emit(topic_id, {"type": "think", "icon": "🧠", "label": "Profiling party",
                                "detail": f"Synthesizing a profile for {name}…"})
            prof = dspy.ChainOfThought(party_intel.SmartAddParty)(
                topic=topic["title"], description=topic["description"],
                party_name=name, existing_names=existing_names, research=research,
            ).profile
            party = prof.model_dump()
            party.update(
                id=writers.unique_party_id(topic_id, name), name=party.get("name") or name,
                weight=0, weight_factors={}, weight_evidence={},
                auto_discovered=False, user_verified=True,
            )
            return party_intel.rescore_party(topic["title"], topic["description"], party)

    try:
        scored = await asyncio.to_thread(_work)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail={"message": f"Smart add failed: {e}"})
    await asyncio.to_thread(writers.upsert_party, topic_id, scored)
    bus.emit(topic_id, {"type": "think", "icon": "✅", "label": f"Smart add complete: {scored.get('name', name)}"})
    return scored


@router.post("/api/topics/{topic_id}/parties/{party_id}/smart-edit")
async def smart_edit_party(topic_id: str, party_id: str, body: SmartEditBody):
    """LLM-edit a party from feedback (PartiesPanel smart edit), then rescore + persist."""
    topic = await _require_topic(topic_id)
    fb = body.feedback.strip()
    if not fb:
        raise HTTPException(status_code=400, detail={"message": "feedback is required"})
    current = await asyncio.to_thread(writers.get_party, topic_id, party_id)
    if current is None:
        raise HTTPException(status_code=404, detail={"message": "Party not found"})
    # ⇄ TS PartyIntelligence.smartEditParty emitThink — match the exact label/icon the frontend renders.
    bus.emit(topic_id, {"type": "think", "icon": "📝", "label": f"Smart edit: {current['name']}", "detail": fb[:100]})
    model = dspy_lm.model_for(topic_id, "data_gathering")

    def _work():
        with dspy_lm.lm_context(model):
            research = party_intel.gather_party_research(
                topic_id, topic["title"], current["name"], fb,
                emit=lambda e: bus.emit(topic_id, e))
            bus.emit(topic_id, {"type": "think", "icon": "🧠", "label": "Re-profiling party",
                                "detail": f"Applying your feedback to {current['name']}…"})
            prof = dspy.ChainOfThought(party_intel.SmartEditParty)(
                topic=topic["title"], current_party=json.dumps(current), feedback=fb, research=research,
            ).profile
            edited = {**current, **prof.model_dump(), "id": current["id"],
                      "auto_discovered": False, "user_verified": True}
            return party_intel.rescore_party(topic["title"], topic["description"], edited)

    try:
        scored = await asyncio.to_thread(_work)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail={"message": f"Smart edit failed: {e}"})
    scored["id"] = current["id"]
    await asyncio.to_thread(writers.upsert_party, topic_id, scored)
    bus.emit(topic_id, {"type": "think", "icon": "✅", "label": f"Smart edit complete: {scored['name']}"})
    return scored


@router.post("/api/topics/{topic_id}/parties/split")
async def split_party(topic_id: str, body: SplitBody):
    """Split one party into >=2 named sub-parties (PartiesPanel split). LLM distributes attributes;
    each sub-party is rescored. The source is removed and the new parties persisted."""
    topic = await _require_topic(topic_id)
    if not body.source_id:
        raise HTTPException(status_code=400, detail={"message": "source_id is required"})
    names = [i.name for i in body.into if i.name.strip()]
    if len(names) < 2:
        raise HTTPException(status_code=400, detail={"message": "Need at least 2 target names"})
    source = await asyncio.to_thread(writers.get_party, topic_id, body.source_id)
    if source is None:
        raise HTTPException(status_code=404, detail={"message": "Party not found"})
    bus.emit(topic_id, {"type": "think", "icon": "🪓", "label": f"Splitting {source['name']}", "detail": ", ".join(names)[:100]})
    model = dspy_lm.model_for(topic_id, "data_gathering")

    def _work():
        with dspy_lm.lm_context(model):
            profs = dspy.ChainOfThought(party_intel.SmartSplitParty)(
                topic=topic["title"], source_party=json.dumps(source), into_names=names,
            ).parties or []
            created = []
            used: set[str] = set()  # local id-dedup within this split batch
            for i, nm in enumerate(names):
                prof = profs[i].model_dump() if i < len(profs) else {"name": nm}
                pid = writers.unique_party_id(topic_id, prof.get("name") or nm)
                while pid in used:
                    pid = pid + "-x"
                used.add(pid)
                party = {**prof, "id": pid, "name": prof.get("name") or nm,
                         "weight": 0, "weight_factors": {}, "weight_evidence": {},
                         "auto_discovered": False, "user_verified": True}
                created.append(party_intel.rescore_party(topic["title"], topic["description"], party))
            return created

    try:
        created = await asyncio.to_thread(_work)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail={"message": f"Split failed: {e}"})
    await asyncio.to_thread(writers.delete_party, topic_id, body.source_id)
    for p in created:
        await asyncio.to_thread(writers.upsert_party, topic_id, p)
    # Repoint clues from the split source to the primary new party so they don't dangle.
    if created:
        await asyncio.to_thread(writers.remap_party_in_clues, topic_id, [body.source_id], created[0].get("id"))
    bus.emit(topic_id, {"type": "think", "icon": "✅", "label": f"Split complete: {', '.join(p['name'] for p in created)}"[:120]})
    return {"removed": body.source_id, "created": created}


# NOTE: the clue routes (GET list / GET one / POST add / PUT edit / DELETE / smart-edit / research /
# bulk / update-all / cleanup) live in api/clues.py, which supersedes the two stubs that used to be
# here (adding ?version handling on GET and the missing markStale on DELETE).


# ── Verdict / expert council (⇄ TS expertCouncil.ts) ───────────────────────────
@router.get("/api/topics/{topic_id}/expert-council")
async def get_expert_council(topic_id: str):
    return await reads.get_expert_council(topic_id)


@router.get("/api/topics/{topic_id}/expert-council/{version}")
async def get_expert_council_version(topic_id: str, version: int):
    data = await reads.get_expert_council(topic_id, version)
    if data is None:
        raise HTTPException(status_code=404, detail={"message": "Expert council not found for this version"})
    return data


@router.get("/api/topics/{topic_id}/verdict")
async def get_verdict(topic_id: str):
    council = await reads.get_expert_council(topic_id)
    return council.get("final_verdict") if council else None


@router.get("/api/topics/{topic_id}/verdict/{version}")
async def get_verdict_version(topic_id: str, version: int):
    council = await reads.get_expert_council(topic_id, version)
    return council.get("final_verdict") if council else None


# ── Forum (⇄ TS forum.ts) ──────────────────────────────────────────────────────
@router.get("/api/topics/{topic_id}/representatives")
async def get_representatives(topic_id: str, version: int | None = None):
    """Representatives for a topic. With ?version=, serve that version's pinned
    representatives_snapshot for a completed historical version (⇄ TS forum route ?version=)."""
    if version is not None:
        return await reads.list_representatives_at_version(topic_id, version)
    return await reads.list_representatives(topic_id)


@router.get("/api/topics/{topic_id}/forum")
async def get_forum(topic_id: str, version: int | None = None):
    """Forum session. With ?version=, resolve the version's forum_session_id from `states` and
    serve that session — but only once the forum stage completed for that version (⇄ TS forum
    route ?version=). Without it, the latest session."""
    if version is not None:
        state = await reads._get_state(topic_id, version)
        if not state or "forum" not in state["completed_stages"] or not state["forum_session_id"]:
            return None
        return await reads.get_forum_session(topic_id, session_id=state["forum_session_id"])
    return await reads.get_forum_session(topic_id)


@router.get("/api/topics/{topic_id}/forum/{session_id}")
async def get_forum_by_session(topic_id: str, session_id: str):
    data = await reads.get_forum_session(topic_id, session_id=session_id)
    if data is None:
        raise HTTPException(status_code=404, detail={"message": "Forum session not found"})
    return data

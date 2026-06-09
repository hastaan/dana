"""StormResearchEngine — the STORM-style Discovery+Enrichment core.

analogues -> personas (parties/lenses) -> grounded conversations -> distilled clues.
Adapted to Dana's adversarial frame: personas ARE the parties/lenses, and conversation
output is Dana clues (not prose). Sync DSPy program; run off-loop in a worker thread.
"""
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable

import dspy

from ..db import writers
from . import signatures as sig
from .retriever import DanaRetriever, Information, ResearchBudget

Emit = Callable[[dict], None]


@dataclass
class Persona:
    kind: str            # "party" | "lens"
    name: str
    role: str            # agenda (party) or focus (lens)
    ptype: str | None = None
    party_id: str | None = None

    def render(self) -> str:
        tag = f"party ({self.ptype})" if self.kind == "party" else "analytical lens"
        return f"{self.name} — {tag}. Focus: {self.role}"


import os


@dataclass
class ResearchConfig:
    # `max_personas` bounds CONVERSATION breadth (how many actors we interview the web about) —
    # this is the performance knob. `max_parties` is decoupled and larger so the discovered set
    # can hold internal factions + external state actors + named alliances WITHOUT the 5-cap
    # squeezing external players out (the TS era had no discovery-time party cap).
    max_personas: int = field(default_factory=lambda: int(os.getenv("DANA_RESEARCH_MAX_PERSONAS", "5")))
    max_parties: int = field(default_factory=lambda: int(os.getenv("DANA_RESEARCH_MAX_PARTIES", "12")))
    max_turns: int = field(default_factory=lambda: int(os.getenv("DANA_RESEARCH_MAX_TURNS", "3")))
    top_k: int = field(default_factory=lambda: int(os.getenv("DANA_RESEARCH_TOP_K", "4")))
    max_searches: int = field(default_factory=lambda: int(os.getenv("DANA_RESEARCH_MAX_SEARCHES", "24")))


def _fmt_info(infos: list[Information]) -> str:
    parts = []
    for i, x in enumerate(infos):
        body = (x.content[:1500] if x.content else x.snippet) or x.snippet or "(no excerpt)"
        parts.append(f"[{i + 1}] {x.title} ({x.url}):\n{body}")
    return "\n\n".join(parts) or "N/A"


class GroundedResearcher(dspy.Module):
    def __init__(self, retriever: DanaRetriever, max_queries: int = 3):
        self.gen_queries = dspy.Predict(sig.QuestionToQueries)
        self.answer = dspy.Predict(sig.GroundedAnswer)
        self.retriever = retriever
        self.max_queries = max_queries

    def forward(self, topic: str, question: str, persona: str):
        queries = self.gen_queries(topic=topic, question=question).queries[: self.max_queries]
        infos = self.retriever.retrieve(queries, persona=persona)
        if not infos:
            return dspy.Prediction(answer="INSUFFICIENT_EVIDENCE", queries=queries, retrieved=[])
        ans = self.answer(topic=topic, question=question, info=_fmt_info(infos)).answer
        return dspy.Prediction(answer=ans, queries=queries, retrieved=infos)


class StormResearchEngine:
    def __init__(self, topic_id: str, cfg: ResearchConfig | None = None):
        self.topic_id = topic_id
        self.cfg = cfg or ResearchConfig()
        self.budget = ResearchBudget(max_searches=self.cfg.max_searches)
        self.retriever = DanaRetriever(topic_id, self.budget, top_k=self.cfg.top_k)
        self.survey = dspy.ChainOfThought(sig.SurveyAnalogousCases)
        self.seed = dspy.ChainOfThought(sig.SeedPerspectives)
        self.ask = dspy.ChainOfThought(sig.AskAsPersona)
        self.researcher = GroundedResearcher(self.retriever)
        self.distill = dspy.ChainOfThought(sig.DistillClues)
        self.refine = dspy.ChainOfThought(sig.RefineParties)
        self._used_ids: set[str] = set()  # guarantees unique party ids (slugify truncates to 30 → collisions)

    def _uid(self, name: str) -> str:
        """Unique party id from a name. writers.slugify truncates to 30 chars, so two verbose
        party names sharing a prefix collide → identical ids → set_parties IntegrityError aborts
        the whole discovery persist. Suffix -2/-3 on collision so every party id is distinct."""
        base = writers.slugify(name)
        pid, n = base, 2
        while pid in self._used_ids:
            pid = f"{base}-{n}"
            n += 1
        self._used_ids.add(pid)
        return pid

    # ── Phase 0: ground party-finding in real web evidence (workflow: discovery → deep research) ──
    def _ground_topic(self, topic: str, emit: Emit) -> str:
        """A bounded grounded pass BEFORE seeding so parties are discovered from real reporting,
        not LLM priors. Runs a topic-breadth `deep_search` but EXPLICITLY BOUNDED (2 personas ×
        2 turns) so it adds only ~12 searches, not the full topic-breadth budget — discovery
        already has its own ~24-search budget, and over-querying is what self-suspends SearXNG
        engines. The grounding uses its own (bounded) budget, separate from self.budget. Tune
        with DANA_GROUND_PERSONAS / DANA_GROUND_TURNS; disable with DANA_GROUND_DISCOVERY=0.
        Degrades to '' when search is unavailable. `deep_search` imports this module, so import
        it LAZILY to avoid a circular import at module load."""
        if os.getenv("DANA_GROUND_DISCOVERY", "1") == "0":
            return ""
        # Default 3 grounding angles so one each can target internal factions, EXTERNAL state
        # actors, and the adversarial/conflict dimension — costs only ~6-8 more searches than the
        # old 2×2 and stays well under discovery's own 24-search budget (separate budget).
        gp = int(os.getenv("DANA_GROUND_PERSONAS", "3"))
        gt = int(os.getenv("DANA_GROUND_TURNS", "2"))
        try:
            from .deep_search import deep_search  # lazy: deep_search imports engine
            # geopolitical=True swaps the generic angle generator for the adversarial/external-
            # actor + recency-aware one so external players are guaranteed to be queried for.
            res = deep_search(topic, breadth="topic", topic_id=self.topic_id, emit=emit,
                              max_personas=gp, max_turns=gt, top_k=self.cfg.top_k, geopolitical=True)
        except Exception:  # noqa: BLE001
            return ""
        briefing = (res.get("content") or "").strip() if isinstance(res, dict) else ""
        if not briefing:
            return ""
        emit({"type": "think", "icon": "🌐", "label": "Grounding discovery",
              "detail": f"{len(res.get('sources', []))} sources"})
        return ("Researched real-world context (use these facts to identify the actual parties):\n"
                + briefing)

    # ── Phase 1: perspective seeding ──
    def _seed_personas(self, topic: str, description: str, emit: Emit):
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        grounding = self._ground_topic(topic, emit)
        desc = f"{description}\n\n{grounding}".strip() if grounding else description
        emit({"type": "think", "icon": "🧭", "label": "Surveying analogous cases", "detail": topic[:60]})
        analogues = self.survey(topic=topic, description=desc, today=today).analogues
        seeded = self.seed(topic=topic, description=desc, analogues=analogues)
        # Party set is bounded by max_parties (large) so external actors + alliances survive;
        # conversation breadth is bounded SEPARATELY by max_personas (the perf knob) below.
        party_personas: list[Persona] = []
        parties: list[dict] = []
        for p in seeded.parties[: self.cfg.max_parties]:
            pid = self._uid(p.name)
            circle = {"visible": list(p.member_names), "shadow": []} if p.type == "alliance" else {"visible": [], "shadow": []}
            parties.append({
                "id": pid, "name": p.name, "type": p.type, "description": p.why,
                "agenda": p.agenda, "weight": 0, "stance": "active", "auto_discovered": True,
                "circle": circle,
            })
            party_personas.append(Persona("party", p.name, p.agenda or p.why, ptype=p.type, party_id=pid))
        lens_personas = [Persona("lens", lens.name, lens.focus) for lens in seeded.lenses]
        # Interview the most salient parties first, then lenses, capped to max_personas for perf.
        personas = (party_personas + lens_personas)[: self.cfg.max_personas]
        emit({"type": "think", "icon": "🎭", "label": f"{len(parties)} parties, {len(seeded.lenses)} lenses",
              "detail": ", ".join(pp["name"] for pp in parties)[:120]})
        return parties, personas, list(seeded.outline)

    # ── Phase 2: grounded conversation per persona ──
    def _converse(self, topic: str, persona: Persona, outline: list[str], emit: Emit) -> list[dict]:
        history: list[dict] = []
        gaps = "; ".join(outline)
        for turn_i in range(self.cfg.max_turns):
            if not self.budget.can_search():
                break
            conv = "\n".join(f"You: {t['q']}\nResearcher: {t['a'][:400]}" for t in history) or "N/A"
            q = self.ask(topic=topic, persona=persona.render(), conv=conv, coverage_gaps=gaps).question
            if "NO_FURTHER_QUESTIONS" in q:
                break
            emit({"type": "think", "icon": "🔎", "label": f"{persona.name} asks", "detail": q[:100]})
            r = self.researcher(topic=topic, question=q, persona=persona.name)
            history.append({"q": q, "a": r.answer, "urls": [i.url for i in r.retrieved],
                            "outlets": [i.title for i in r.retrieved]})
            emit({"type": "think", "icon": "📄", "label": f"{persona.name} learns ({len(r.retrieved)} src)",
                  "detail": r.answer[:160]})
            emit({"type": "progress", "stage": "discovery", "pct": 0.5,
                  "msg": f"{persona.name}: {len(r.retrieved)} sources"})
        return history

    # ── Phase 3: distill clues ──
    def _distill_clues(self, topic: str, persona: Persona, history: list[dict], emit: Emit) -> list[dict]:
        if not history:
            return []
        convtext = "\n\n".join(
            f"Q: {t['q']}\nA: {t['a']}\nSources: {', '.join(t['urls'])}" for t in history
        )
        urls = list({u for t in history for u in t["urls"]})
        outlets = list({o for t in history for o in t["outlets"]})
        drafted = self.distill(topic=topic, persona=persona.render(), conversation=convtext).clues
        clues: list[dict] = []
        for d in drafted:
            clues.append({
                "title": d.title, "summary": d.summary, "clue_type": d.clue_type,
                "relevance": d.relevance, "credibility": d.credibility, "key_points": d.key_points,
                "party_relevance": [persona.party_id] if persona.party_id else [],
                "source_urls": urls[:8], "source_outlets": outlets[:8],
                "domain_tags": [persona.name] if persona.kind == "lens" else [],
            })
            # Shape MUST match the frontend (PipelineActivityFeed / useSSE clue_discovered:
            # {clue_id, title, source, relevance}) — a nested {clue:{…}} rendered as
            # "undefined · relevance NaN". relevance is already 0-100 (ClueDraft.relevance).
            emit({"type": "clue_discovered", "clue_id": writers.slugify(d.title),
                  "title": d.title, "source": persona.name, "relevance": d.relevance})
        return clues

    # ── Phase 3.5: consolidate parties (ADD missed externals + GROUP into alliances) ──
    def _refine_parties(self, topic: str, parties: list[dict], clues: list[dict], emit: Emit) -> list[dict]:
        """Single non-search LLM pass over the discovered parties + gathered clues that ports the
        deleted TS refine-parties.md (ADD / GROUP-INTO-ALLIANCE / DELETE). This is the ONLY place
        we (a) inject EXTERNAL actors the evidence named but seeding missed and (b) mint named
        type='alliance' coalition parties. Costs exactly one LLM call, zero extra web searches.
        Non-fatal: any failure leaves the seeded parties untouched (mirrors the TS try/catch)."""
        if os.getenv("DANA_REFINE_DISCOVERY", "1") == "0" or not parties:
            return parties
        evidence = "\n".join(
            f"- {c.get('title', '')}: {c.get('summary', '')[:200]}" for c in clues[:30]
        ) or "(no clues gathered)"
        party_str = "\n".join(
            f"- {p['name']} ({p.get('type', '?')}): {p.get('agenda') or p.get('description') or '—'}"
            for p in parties
        )
        try:
            dec = self.refine(topic=topic, parties=party_str, evidence=evidence)
        except Exception:  # noqa: BLE001
            return parties
        def _find(nm: str):
            """Resolve an LLM-supplied member name to a live party by exact name OR slug, so a
            paraphrase ("US" vs "United States (Trump admin)") doesn't silently drop a coalition."""
            nl, ns = nm.lower().strip(), writers.slugify(nm)
            for p in parties:
                if p["name"].lower() == nl or writers.slugify(p["name"]) == ns:
                    return p
            return None

        # ADD — inject evidenced actors (esp. external states) missing from the seed.
        for a in (dec.add or []):
            if _find(a.name) is not None:
                continue
            parties.append({
                "id": self._uid(a.name), "name": a.name, "type": a.type,
                "description": a.reason, "agenda": a.reason, "weight": 0, "stance": "active",
                "auto_discovered": True, "circle": {"visible": [], "shadow": []},
            })
            emit({"type": "think", "icon": "➕", "label": f"Adding · {a.name}", "detail": a.reason[:100]})

        # DELETE — drop actors the evidence shows have no agency.
        for d in (dec.remove or []):
            tgt = _find(d.name)
            if tgt is not None:
                parties[:] = [p for p in parties if p is not tgt]
                emit({"type": "think", "icon": "➖", "label": f"Removing · {d.name}", "detail": d.reason[:100]})

        # GROUP — materialize aligned blocs into a single type='alliance' party
        # (ports DiscoveryAgent.ts STEP 3). keep_separate members are left untouched.
        for g in (dec.group or []):
            keep = {writers.slugify(n) for n in (g.keep_separate or [])}
            members, seen_m = [], set()
            for n in g.member_names:
                m = _find(n)
                if m is None or writers.slugify(m["name"]) in keep or id(m) in seen_m:
                    continue
                seen_m.add(id(m))
                members.append(m)
            if len(members) < 2:
                continue
            alliance = {
                "id": self._uid(g.alliance_name), "name": g.alliance_name, "type": "alliance",
                "description": f"Alliance of {', '.join(m['name'] for m in members)}. {g.reason}",
                "agenda": "; ".join(dict.fromkeys(m.get("agenda", "") for m in members if m.get("agenda"))),
                "weight": 0, "stance": members[0].get("stance", "active"), "auto_discovered": True,
                "circle": {"visible": [m["name"] for m in members], "shadow": []},
            }
            member_ids = {id(m) for m in members}
            parties[:] = [p for p in parties if id(p) not in member_ids]
            parties.append(alliance)
            emit({"type": "think", "icon": "🤝",
                  "label": f"Alliance · {' + '.join(m['name'] for m in members)} → {g.alliance_name}",
                  "detail": g.reason[:100]})
        return parties[: self.cfg.max_parties]

    # ── Enrichment: deeper per-party research over EXISTING parties ──
    def enrich(self, topic: str, description: str, parties: list[dict], emit: Emit) -> dict:
        """Reuse the grounded conversation/distill loop, but seed personas from the parties
        already discovered and aim questions at their vulnerabilities, capabilities, and
        recent moves (delta clues). Parties are not re-discovered."""
        gaps = [
            "recent decisions, statements, and moves by this party",
            "this party's vulnerabilities, constraints, and red lines",
            "shifts in this party's capabilities or external support",
        ]
        personas = [
            Persona("party", p["name"], p.get("agenda") or p.get("description") or "", ptype=p.get("type"),
                    party_id=p["id"])
            for p in parties[: self.cfg.max_personas]
        ]
        all_clues: list[dict] = []
        for idx, persona in enumerate(personas):
            emit({"type": "progress", "stage": "enrichment", "pct": 0.1 + 0.8 * idx / max(1, len(personas)),
                  "msg": f"Enriching: {persona.name} ({idx + 1}/{len(personas)})"})
            history = self._converse(topic, persona, gaps, emit)
            all_clues.extend(self._distill_clues(topic, persona, history, emit))
        return {"clues": all_clues, "searches_used": self.budget.searches_used,
                "cache_hits": self.budget.cache_hits}

    # ── Orchestrate ──
    def run(self, topic: str, description: str, emit: Emit) -> dict:
        parties, personas, outline = self._seed_personas(topic, description, emit)
        all_clues: list[dict] = []
        for idx, persona in enumerate(personas):
            emit({"type": "progress", "stage": "discovery", "pct": 0.1 + 0.8 * idx / max(1, len(personas)),
                  "msg": f"Researching: {persona.name} ({idx + 1}/{len(personas)})"})
            history = self._converse(topic, persona, outline, emit)
            all_clues.extend(self._distill_clues(topic, persona, history, emit))
        # Consolidate: ADD evidenced externals + GROUP aligned blocs into named alliances.
        parties = self._refine_parties(topic, parties, all_clues, emit)
        return {
            "parties": parties, "clues": all_clues, "outline": outline,
            "searches_used": self.budget.searches_used, "cache_hits": self.budget.cache_hits,
        }

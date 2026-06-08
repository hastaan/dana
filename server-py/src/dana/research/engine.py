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
    max_personas: int = field(default_factory=lambda: int(os.getenv("DANA_RESEARCH_MAX_PERSONAS", "5")))
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

    # ── Phase 1: perspective seeding ──
    def _seed_personas(self, topic: str, description: str, emit: Emit):
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        emit({"type": "think", "icon": "🧭", "label": "Surveying analogous cases", "detail": topic[:60]})
        analogues = self.survey(topic=topic, description=description, today=today).analogues
        seeded = self.seed(topic=topic, description=description, analogues=analogues)
        personas: list[Persona] = []
        parties: list[dict] = []
        for p in seeded.parties[: self.cfg.max_personas]:
            pid = writers.slugify(p.name)
            parties.append({
                "id": pid, "name": p.name, "type": p.type, "description": p.why,
                "agenda": p.agenda, "weight": 0, "stance": "active", "auto_discovered": True,
            })
            personas.append(Persona("party", p.name, p.agenda or p.why, ptype=p.type, party_id=pid))
        for lens in seeded.lenses:
            personas.append(Persona("lens", lens.name, lens.focus))
        emit({"type": "think", "icon": "🎭", "label": f"{len(parties)} parties, {len(seeded.lenses)} lenses",
              "detail": ", ".join(pp["name"] for pp in parties)[:120]})
        return parties, personas[: self.cfg.max_personas], list(seeded.outline)

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
            emit({"type": "clue_discovered", "clue": {"title": d.title, "persona": persona.name}})
        return clues

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
        return {
            "parties": parties, "clues": all_clues, "outline": outline,
            "searches_used": self.budget.searches_used, "cache_hits": self.budget.cache_hits,
        }

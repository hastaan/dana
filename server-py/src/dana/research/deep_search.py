"""deep_search tier — multi-angle grounded research → synthesized, cited briefing.

Native: it orchestrates several `deep_lookup`s (the `GroundedResearcher` primitive) across
distinct investigative angles, then synthesizes a cited markdown briefing. Breadth-parameterized
so the SAME engine serves a bounded per-clue pass, topic-level party discovery, and a long-form
article — all on Dana's LM (CLIProxyAPI/MiniMax + `<think>` strip) and the Phase-A robustness.
"""
from typing import Callable

import dspy

from ..db import reads, writers
from ..llm import dspy_lm
from .engine import GroundedResearcher
from .retriever import DanaRetriever, ResearchBudget

Emit = Callable[[dict], None]


def _noop_emit(_ev: dict) -> None:
    """Silent default so standalone callers (emit=None) are unaffected."""

# breadth → (research angles, questions per angle, results per search)
BREADTH = {
    "clue": {"personas": 1, "turns": 2, "top_k": 4},
    "topic": {"personas": 3, "turns": 3, "top_k": 5},
    "article": {"personas": 4, "turns": 4, "top_k": 6},
}


class ResearchAngles(dspy.Signature):
    """List distinct, non-overlapping investigative angles to research the subject thoroughly
    (e.g. actors, capabilities, timeline, incentives, precedents). One short phrase each."""

    subject: str = dspy.InputField()
    n: int = dspy.InputField(desc="how many angles")
    angles: list[str] = dspy.OutputField()


class NextQuestion(dspy.Signature):
    """Ask the next specific, publicly-answerable research question for this angle, given what
    is already known. Return NO_FURTHER if the angle is well covered."""

    subject: str = dspy.InputField()
    angle: str = dspy.InputField()
    known: str = dspy.InputField()
    question: str = dspy.OutputField()


class SynthesizeBriefing(dspy.Signature):
    """Synthesize the findings into a well-structured briefing in markdown. Cite sources inline
    as [n] matching the numbered SOURCES list. Ground every claim in the findings; never invent.
    Note disagreements between sources rather than averaging them away."""

    subject: str = dspy.InputField()
    findings: str = dspy.InputField(desc="Q/A pairs with numbered source citations")
    briefing: str = dspy.OutputField()


def deep_search(
    query: str,
    *,
    breadth: str = "topic",
    topic_id: str = "adhoc-deep",
    max_personas: int | None = None,
    max_turns: int | None = None,
    top_k: int | None = None,
    emit: Emit | None = None,
) -> dict:
    """`emit` (optional) streams SSE-style dict events (think per angle / progress) for
    traceability; None is fully silent. Synthesized briefings are cached (24h TTL,
    keyed by breadth+query) so re-runs are cheap."""
    emit = emit or _noop_emit
    # Fold breadth + any explicit budget overrides into the key so a deeper/narrower call
    # doesn't collide with a default-breadth one.
    cache_key = f"{breadth}:{max_personas}:{max_turns}:{top_k}:{query}"
    cached = reads.get_cached_synthesis(topic_id, "deep_search", cache_key)
    if cached is not None:
        emit({"type": "think", "icon": "💾", "label": "Cached briefing", "detail": query[:80]})
        return {**cached, "cached": True}

    with dspy_lm.lm_context():
        preset = BREADTH.get(breadth, BREADTH["topic"])
        n_personas = max_personas or preset["personas"]
        n_turns = max_turns or preset["turns"]
        k = top_k or preset["top_k"]

        budget = ResearchBudget(max_searches=n_personas * n_turns * 2 + 4)
        retriever = DanaRetriever(topic_id, budget, top_k=k, fetch_top=2)
        researcher = GroundedResearcher(retriever)
        gen_angles = dspy.Predict(ResearchAngles)
        next_q = dspy.Predict(NextQuestion)
        synth = dspy.ChainOfThought(SynthesizeBriefing)

        emit({"type": "progress", "stage": "deep_search", "pct": 0.05, "msg": f"Researching: {query[:80]}"})
        angles = (gen_angles(subject=query, n=n_personas).angles or [])[:n_personas] or [query]
        emit({"type": "think", "icon": "🧭", "label": f"{len(angles)} research angles",
              "detail": ", ".join(angles)[:120]})
        findings: list[tuple[str, str, list]] = []
        sources: list[dict] = []
        src_n: dict[str, int] = {}

        for idx, angle in enumerate(angles):
            emit({"type": "progress", "stage": "deep_search", "pct": 0.1 + 0.8 * idx / max(1, len(angles)),
                  "msg": f"Angle: {angle[:60]} ({idx + 1}/{len(angles)})"})
            emit({"type": "think", "icon": "🔭", "label": "Research angle", "detail": angle[:100]})
            known = ""
            for _ in range(n_turns):
                if not budget.can_search():
                    break
                q = next_q(subject=query, angle=angle, known=known or "nothing yet").question
                if "NO_FURTHER" in q.upper():
                    break
                emit({"type": "think", "icon": "🔎", "label": f"{angle[:40]} asks", "detail": q[:100]})
                pred = researcher(topic=query, question=q, persona=angle)
                for i in pred.retrieved:
                    if i.url and i.url not in src_n:
                        src_n[i.url] = len(sources) + 1
                        sources.append({"n": len(sources) + 1, "title": i.title, "url": i.url})
                findings.append((q, pred.answer, pred.retrieved))
                known += f"\nQ: {q}\nA: {pred.answer[:300]}"

        parts = []
        for q, a, infos in findings:
            cites = ", ".join(f"[{src_n[i.url]}]" for i in infos if i.url in src_n)
            parts.append(f"Q: {q}\nA: {a}\nSources: {cites or '—'}")
        src_list = "\n".join(f"[{s['n']}] {s['title']} — {s['url']}" for s in sources)
        findings_text = ("\n\n".join(parts) + "\n\nSOURCES:\n" + src_list)[:14000]
        emit({"type": "progress", "stage": "deep_search", "pct": 0.95, "msg": "Synthesizing briefing…"})
        briefing = synth(subject=query, findings=findings_text).briefing if findings else ""

        result = {
            "status": "success", "level": "deep_search", "breadth": breadth, "query": query,
            "content": briefing,
            "sources": [{"title": s["title"], "url": s["url"]} for s in sources],
            "source_urls": [s["url"] for s in sources],
            "findings_count": len(findings),
            "searches_used": budget.searches_used,
        }
        emit({"type": "progress", "stage": "deep_search", "pct": 1.0,
              "msg": f"Briefing complete — {len(sources)} sources, {len(findings)} findings"})
        writers.cache_synthesis(topic_id, "deep_search", cache_key, result)
        return result

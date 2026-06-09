"""Clue-management intelligence (⇄ deleted TS agents/{SmartClueExtractor,BulkImportAgent,
EvidenceUpdateAgent,CleanupAgent,FactCheckAgent}.ts + prompts/clue-extractor/*.md +
prompts/enrichment/fact-check.md).

BOUNDED ports: the TS agents ran an agentic tool loop (web_search/fetch_url/store_clue over
many rounds). Here every operation GATHERS context with hard caps (web_search + http_fetch,
corpus-aware, <=4 queries x 2 fetches, 12000-char slice) and then makes ONE batched, typed
DSPy call. DSPy's typed Pydantic outputs replace the TS JSON-regex salvage; every call is
wrapped in try/except with an empty/keep fallback (mirrors party_intel.rescore_party).

Sync — run inside asyncio.to_thread under dspy_lm.lm_context(). The docstrings ARE the prompts.
"""
from datetime import datetime, timezone
from typing import Callable, Literal

import dspy
from pydantic import BaseModel, Field

from ..db import writers
from ..tools.http_fetch import http_fetch
from ..tools.web_search import web_search

Emit = Callable[[dict], None]


def _noop_emit(_ev: dict) -> None:
    """Silent default so standalone callers (emit=None) are unaffected."""


def _year() -> str:
    return str(datetime.now(timezone.utc).year)


def _today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


# Hosts whose pages we never fetch (anti-bot / login-walled social) — use the search snippet
# instead. Ported verbatim from SmartClueExtractor.isFetchable().
_NON_FETCHABLE = ("x.com", "twitter.com", "instagram.com", "facebook.com", "truthsocial.com", "t.me")


def is_fetchable(url: str) -> bool:
    try:
        import re
        m = re.match(r"https?://([^/?#]+)", url or "", re.I)
        host = (m.group(1) if m else "").lower()
        return bool(host) and not any(s in host for s in _NON_FETCHABLE)
    except Exception:  # noqa: BLE001
        return False


def _party_list(parties: list[dict]) -> str:
    """`id: name` per line (⇄ TS `${p.id}: ${p.name}`)."""
    return "\n".join(f"{p['id']}: {p['name']}" for p in parties) or "No parties defined yet."


# ── Pydantic typed outputs (replace TS JSON-regex parsing) ──────────────────────────
class ExtractedClue(BaseModel):
    title: str
    summary: str = ""
    date: str = "unknown"
    relevance: int = 70
    credibility: int = 50
    parties: list[str] = Field(default_factory=list)
    source_url: str = ""
    source_outlet: str = ""
    bias_flags: list[str] = Field(default_factory=list)
    clue_type: str = "event"
    domain_tags: list[str] = Field(default_factory=list)
    key_points: list[str] = Field(default_factory=list)


class EditedClue(BaseModel):
    title: str
    summary: str
    credibility: int
    bias_flags: list[str] = Field(default_factory=list)
    relevance: int
    parties: list[str] = Field(default_factory=list)
    date: str
    clue_type: str = "event"
    domain_tags: list[str] = Field(default_factory=list)


class ClueUpdate(BaseModel):
    has_update: bool = False
    updated_title: str = ""
    updated_summary: str = ""
    updated_date: str = ""
    updated_clue_type: str = ""
    new_source_urls: list[str] = Field(default_factory=list)
    new_source_outlets: list[str] = Field(default_factory=list)
    credibility: int = 50
    bias_flags: list[str] = Field(default_factory=list)
    key_points: list[str] = Field(default_factory=list)
    update_note: str = ""


class ScanCandidate(BaseModel):
    ids: list[str] = Field(default_factory=list)
    type: Literal["dedup", "consolidate", "garbage"] = "dedup"
    reason: str = ""


class ClueGroup(BaseModel):
    group_id: str
    category: str = ""
    merged_title: str = ""
    merged_summary: str = ""
    merged_credibility: int = 60
    merged_bias_flags: list[str] = Field(default_factory=list)
    merged_relevance: int = 70
    merged_date: str = ""
    merged_clue_type: str = "event"
    merged_domain_tags: list[str] = Field(default_factory=list)
    merged_parties: list[str] = Field(default_factory=list)
    source_clue_ids: list[str] = Field(default_factory=list)
    action: Literal["merge", "keep", "delete"] = "keep"
    reason: str = ""
    consolidation_type: str | None = None


class FactVerdict(BaseModel):
    verdict: Literal["verified", "disputed", "misleading", "unverifiable"] = "unverifiable"
    bias_analysis: str = ""
    counter_evidence: str = ""
    cui_bono: str = ""
    adjusted_credibility: int = 50
    adjusted_bias_flags: list[str] = Field(default_factory=list)


# ── DSPy signatures (each __doc__ ports the corresponding prompt) ───────────────────
class ExtractClues(dspy.Signature):  # port extract.md + research.md (same schema)
    """You are an intelligence analyst extracting structured factual claims from mixed-format
    intelligence/research material (narrative text, dated updates, source links, analysis).

    Extract every distinct factual event, statement, or development as a SEPARATE clue. Be
    thorough — every fact matters. Each clue = ONE distinct fact/event/statement; do NOT merge
    multiple events into one clue.

    Rules:
    - Attribute to the actual speaker/source (e.g. "Netanyahu stated…" not just "Israel").
    - For military strikes: include location, target type, and claimed results.
    - For statements: quote key phrases and attribute precisely.
    - Use the party IDs from party_list in `parties`; create new slugs only if no match.
    - credibility: official military/govt sources 70-85, verified journalists 60-75,
      unconfirmed/OSINT 40-55.
    - bias_flags: state_media, propaganda, unverified, osint, official_statement, opposition_media.
    - relevance 50-100. date = YYYY-MM-DD or "unknown".
    - clue_type: event|statement|military_action|intelligence|economic|diplomatic.
    - domain_tags: military|nuclear|economic|political|social|intelligence.
    - Extract as many clues as the content warrants — no maximum limit."""
    topic: str = dspy.InputField(desc="topic title: description")
    party_list: str = dspy.InputField(desc="KNOWN PARTIES — use these ids in `parties`")
    content: str = dspy.InputField(desc="the intelligence brief / gathered research sources")
    clues: list[ExtractedClue] = dspy.OutputField()


class SmartEditClue(dspy.Signature):  # port edit.md (minus the tool loop)
    """You are an intelligence analyst updating a clue/evidence item based on user feedback and
    freshly-gathered research. Analyze the feedback and the current clue to understand what needs
    updating, then return the updated clue. Preserve accurate information; only change what the
    feedback and research warrant. Be specific and fact-based — cite specific dates, numbers, and
    events from the research. credibility/relevance 0-100; clue_type:
    event|statement|military_action|intelligence|economic|diplomatic."""
    topic: str = dspy.InputField()
    current_clue: str = dspy.InputField(desc="the current clue as JSON")
    feedback: str = dspy.InputField()
    research: str = dspy.InputField(desc="gathered web research (may be empty)")
    updated: EditedClue = dspy.OutputField()


class GenerateSearchQueries(dspy.Signature):  # port queries.md
    """You generate targeted web search queries to investigate a specific research direction for
    geopolitical analysis. Produce 3-5 specific, fact-finding search query strings that would
    uncover concrete evidence, events, statements, or data related to the research direction.
    Focus on recent news and verifiable facts."""
    topic: str = dspy.InputField()
    research_direction: str = dspy.InputField()
    queries: list[str] = dspy.OutputField(desc="3-5 search query strings")


class UpdateClue(dspy.Signature):  # port update-clue.md (minus the tool loop)
    """You are an intelligence analyst checking whether a piece of evidence needs updating with
    newer information, using freshly-gathered research about developments AFTER the clue's date.

    Decide:
    - If you found meaningful new information (follow-up events/outcomes, corrections/retractions,
      newer data superseding original figures, new statements from the same parties): set
      has_update=true and fill the updated fields (synthesize a summary combining old + new info,
      most-recent date, new source urls/outlets, key points, and a brief update_note explaining
      what changed).
    - If no significant update exists: set has_update=false (other fields may be empty)."""
    topic: str = dspy.InputField(desc="topic title: description")
    description: str = dspy.InputField(desc="the clue to check, as a readable summary")
    clue_json: str = dspy.InputField(desc="the current clue version as JSON")
    research: str = dspy.InputField(desc="gathered web research on developments since the clue date")
    update: ClueUpdate = dspy.OutputField()


class CleanupScan(dspy.Signature):  # port cleanup-scan.md
    """You are reviewing a structured index of evidence clues for a topic. Identify clues that
    should be merged or deleted. Output ONLY the candidates that need action — clues not listed
    are kept automatically (output an empty list if nothing qualifies).

    Index line format: [id] "title" (date, type) | parties: X, Y | "first 100 chars of summary…"

    THREE TYPES:
    - dedup: same core event/fact reported by different sources within ~7 days (same actor + same
      action/statement even if worded differently; different outlets/wire services). When in
      doubt → FLAG IT.
    - consolidate: 3+ clues forming a coherent narrative thread about the same ongoing situation
      (same party making multiple statements in a short window; same operation across updates;
      same diplomatic stance reiterated same day). MUST be ≥3 clues — never flag pairs for
      consolidate (use dedup). When in doubt → DO NOT FLAG (losing granularity is worse than
      keeping redundancy).
    - garbage: a SINGLE clue only — clearly empty, test data, incoherent, or a processing
      artifact. Use a single-element ids array.

    RULES: do not flag clues that are merely related/thematically similar — they must be the same
    event or same speaker/same day. Do not consolidate clues spanning >14 days unless clearly one
    continuous event. A clue can appear in at most one candidate group."""
    topic_title: str = dspy.InputField()
    clue_index: str = dspy.InputField(desc="one index line per clue")
    candidates: list[ScanCandidate] = dspy.OutputField()


class CleanupResolve(dspy.Signature):  # port cleanup-resolve.md
    """You are an intelligence analyst making a final determination on a group of evidence clues
    flagged for potential merging. The suspicion_type tells you how to treat the group:

    - dedup: clues likely report the SAME specific event from different sources. If confirmed same
      event → merge into ONE richer clue (action=merge): title from most credible source (or
      lightly synthesized), summary preserving ALL unique facts (2-4 sentences), credibility =
      highest among sources, date = most specific/earliest confirmed. If actually distinct → output
      a separate keep for each. If one is fully subsumed with zero unique info → delete it, keep the
      better one. Be CONSERVATIVE: if not certain it's the same event, keep separately.
    - consolidate: clues form a narrative thread (same actor, situation, window). Synthesize into ONE
      narrative summary clue (action=merge): title describes the thread with a date range, summary is
      a coherent 3-5 sentence synthesis of the arc, key points combine all unique key points as a
      timeline, date = most recent, credibility = highest, type = dominant clue_type. Be DECISIVE:
      commit to a merged narrative if the thread is clear. If genuinely too distinct to synthesize →
      output keep for each.
    - garbage: a single clue flagged as artifact/test data. If confirmed → action=delete; if actually
      valid → action=keep.

    Output one group object per OUTPUT clue (merging N clues = 1 object with action=merge; keeping N
    separate = N objects each action=keep). Every input clue id must appear in some group's
    source_clue_ids. merged_credibility/merged_relevance 0-100."""
    topic: str = dspy.InputField()
    suspicion_type: str = dspy.InputField(desc="dedup | consolidate | garbage")
    reason: str = dspy.InputField(desc="why these were flagged")
    clue_detail: str = dspy.InputField(desc="full detail of each clue in the group")
    groups: list[ClueGroup] = dspy.OutputField()


class FactCheckClue(dspy.Signature):  # port fact-check.md (minus the tool loop)
    """You are an ADVERSARIAL intelligence analyst. You did NOT find this clue — you are its
    adversary. Stress-test the evidence using the gathered counter-research:

    1. Source verification: are the cited sources reliable and do they actually say what the clue
       claims? Is this effectively single-sourced (same wire feed republished) or genuinely
       multi-sourced? Any source known for bias/propaganda/agenda?
    2. Counter-evidence: what CONTRADICTS the key claims — alternative data, opposing analyses,
       denied statements, figures disputed by credible authorities?
    3. Bias & cui bono: which parties BENEFIT from this narrative being believed, and why? Is the
       framing neutral or agenda-serving? If disputed, why would someone spread it?

    Verdict guidelines:
    - verified: multiple independent sources confirm, no credible counter-evidence, claims check out.
    - disputed: credible counter-evidence exists, key claims contested by authoritative sources, or
      sources contradict each other.
    - misleading: factually correct but framed to serve an agenda, cherry-picked, missing critical
      context, or mixing facts with speculation.
    - unverifiable: cannot confirm or deny — paywalled sources, too recent, or classified/insider.

    Be skeptical but fair — many clues will be legitimately verified. adjusted_credibility (0-100)
    must reflect YOUR independent assessment, not just echo the original. Always explain your
    reasoning in bias_analysis and cui_bono, even for verified clues. Keep all text fields concise
    (1-2 sentences each)."""
    topic: str = dspy.InputField(desc="topic title: description")
    description: str = dspy.InputField(desc="the clue under review, as a readable summary")
    clue_json: str = dspy.InputField(desc="the clue version as JSON")
    research: str = dspy.InputField(desc="gathered counter-evidence / verification research")
    verdict: FactVerdict = dspy.OutputField()


_DEFAULT_VERDICT = FactVerdict(verdict="unverifiable", bias_analysis="Fact-check could not complete",
                               adjusted_credibility=50)


# ── Bounded research gathering (corpus-aware web_search + http_fetch) ───────────────
def _gather_for_query(
    topic_id: str,
    queries: list[str],
    *,
    fetch_per: int = 2,
    fetch_chars: int = 2000,
    emit: Emit | None = None,
) -> str:
    """Gather source context for a set of search queries (⇄ TS gatherResearch in
    research/edit/update/fact-check). BOUNDED: the caller caps `queries` to <=4 and we fetch the
    top `fetch_per` (=2) results per query. Corpus-aware: a <24h cached search is reused, else
    web_search(sq,3) is stored; per result, non-fetchable hosts use the snippet, otherwise a
    cached page is reused else http_fetch(url, fetch_chars) is stored. Returns the fragments
    `[title] (url)\\n<text|snippet>` joined by `\\n\\n---\\n\\n`, sliced to 12000 chars ("" if
    nothing gathered)."""
    emit = emit or _noop_emit
    fragments: list[str] = []
    for sq in queries[:4]:
        try:
            results = writers.corpus_find_search(topic_id, sq, 24.0)
            if not results:
                results = web_search(sq, 3)
                if results:
                    try:
                        writers.corpus_store_search(topic_id, sq, results, "enrichment")
                    except Exception:  # noqa: BLE001
                        pass
            for r in (results or [])[:fetch_per]:
                url = r.get("url", "")
                title = r.get("title", "") or url
                snippet = r.get("snippet", "") or ""
                if not is_fetchable(url):
                    if snippet:
                        fragments.append(f"[{title}] ({url})\n{snippet}")
                    continue
                cached = None
                try:
                    cached = writers.corpus_get_page(topic_id, url)
                except Exception:  # noqa: BLE001
                    cached = None
                if cached and cached.get("content"):
                    fragments.append(f"[{cached.get('title') or title}] ({url})\n{cached['content'][:fetch_chars]}")
                    continue
                fetched = None
                try:
                    fetched = http_fetch(url, fetch_chars)
                except Exception:  # noqa: BLE001
                    fetched = None
                if fetched:
                    ftitle, ftext = fetched
                    fragments.append(f"[{title}] ({url})\n{ftext[:fetch_chars]}")
                    try:
                        writers.corpus_store_page(topic_id, url, ftitle, ftext, "enrichment")
                    except Exception:  # noqa: BLE001
                        pass
                elif snippet:
                    fragments.append(f"[{title}] ({url})\n{snippet}")
        except Exception:  # noqa: BLE001
            continue
    return "\n\n---\n\n".join(fragments)[:12000]


def _dedupe_by_title(clues: list[ExtractedClue]) -> list[ExtractedClue]:
    """Drop clues whose normalized title (lower, alnum, first 50 chars) repeats (⇄ TS dedupe)."""
    import re
    seen: set[str] = set()
    out: list[ExtractedClue] = []
    for c in clues:
        key = re.sub(r"[^a-z0-9]", "", (c.title or "").lower())[:50]
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(c)
    return out


# ── High-level bounded operations (sync; wrap DSPy under lm_context in the caller) ──
def smart_extract_research(
    topic: str, description: str, query: str, parties: list[dict], *,
    topic_id: str, emit: Emit | None = None,
) -> list[ExtractedClue]:
    """Research a direction → generate queries → gather → extract clues (⇄ researchAndExtractClues).
    BOUNDED: 1 query-gen call + <=4 search queries x2 fetches + 1 extract call."""
    emit = emit or _noop_emit
    try:
        qs = dspy.ChainOfThought(GenerateSearchQueries)(
            topic=topic, research_direction=query).queries or []
    except Exception:  # noqa: BLE001
        qs = []
    if not qs:
        qs = [query, f"{query} {topic} {_year()}"]
    qs = qs[:4]
    ctx = _gather_for_query(topic_id, qs, emit=emit)
    if not ctx:
        return []
    try:
        clues = dspy.ChainOfThought(ExtractClues)(
            topic=f"{topic}: {description}", party_list=_party_list(parties), content=ctx).clues or []
    except Exception:  # noqa: BLE001
        return []
    return _dedupe_by_title(clues)


def smart_extract_from_text(
    topic: str, description: str, content: str, parties: list[dict], existing_index: list[dict],
) -> list[ExtractedClue]:
    """Extract clues from a raw text chunk with existing-clue awareness (⇄ bulk-import.md, bounded).
    No tool loop — ONE extract call; the caller dedupes against the existing index and stores."""
    existing = "\n".join(
        f'[{c["id"]}] "{c["title"]}" ({c.get("timeline_date", "")}, rel={c.get("relevance_score", "")})'
        for c in existing_index
    ) or "No existing clues."
    enriched = f"EXISTING EVIDENCE INDEX (do NOT duplicate these):\n{existing}\n\nCONTENT CHUNK:\n{content}"
    try:
        clues = dspy.ChainOfThought(ExtractClues)(
            topic=f"{topic}: {description}", party_list=_party_list(parties), content=enriched).clues or []
    except Exception:  # noqa: BLE001
        return []
    return clues


def smart_edit_clue(
    topic: str, current_data: dict, feedback: str, *, topic_id: str, emit: Emit | None = None,
) -> EditedClue:
    """Edit a clue from feedback (⇄ smartEditClue, bounded). 1 gather (1 deep query x2 fetch) + 1
    edit call. Raises on LLM/parse failure so the route can return 500 (TS parity)."""
    import json
    emit = emit or _noop_emit
    research = _gather_for_query(topic_id, [f"{feedback} {current_data.get('title', '')}"], emit=emit)
    return dspy.ChainOfThought(SmartEditClue)(
        topic=topic, current_clue=json.dumps(current_data), feedback=feedback, research=research).updated


def update_clue(
    topic: str, description: str, clue_fields: dict, *, topic_id: str, emit: Emit | None = None,
) -> ClueUpdate:
    """Check ONE clue for newer info (⇄ EvidenceUpdateAgent per-clue, bounded). 1 gather (1 query) +
    1 update call. Returns has_update=False on failure."""
    import json
    emit = emit or _noop_emit
    title = clue_fields.get("title", "")
    research = _gather_for_query(topic_id, [f"{title} update {_year()}"], emit=emit)
    summary = f"{title}: {clue_fields.get('bias_corrected_summary', '')}"
    try:
        return dspy.ChainOfThought(UpdateClue)(
            topic=f"{topic}: {description}", description=summary,
            clue_json=json.dumps(clue_fields), research=research).update
    except Exception:  # noqa: BLE001
        return ClueUpdate(has_update=False)


def fact_check_clue(
    topic: str, description: str, clue_fields: dict, *, topic_id: str, emit: Emit | None = None,
) -> FactVerdict:
    """Adversarially fact-check ONE clue (⇄ FactCheckAgent, bounded). 1 gather (1 query) + 1 verdict
    call. ONLY computes+returns the verdict — the caller applies it to the DB. DEFAULT_VERDICT on
    failure."""
    import json
    emit = emit or _noop_emit
    title = clue_fields.get("title", "")
    summary = f"{title}: {clue_fields.get('bias_corrected_summary', '')}"
    research = _gather_for_query(
        topic_id,
        [f"{title} fact check counter evidence",
         f"{title} disputed OR debunked OR contradicted {_year()}"],
        emit=emit,
    )
    try:
        return dspy.ChainOfThought(FactCheckClue)(
            topic=f"{topic}: {description}", description=summary,
            clue_json=json.dumps(clue_fields), research=research).verdict
    except Exception:  # noqa: BLE001
        return _DEFAULT_VERDICT.model_copy()


# ── Cleanup: two-pass scan + resolve (⇄ runCleanupPropose) ──────────────────────────
def clue_to_keep_group(c: dict) -> ClueGroup:
    """Map a clue 1:1 to a keep group (⇄ clueToKeepGroup)."""
    return ClueGroup(
        group_id=c["id"], category=c.get("clue_type", ""), merged_title=c.get("title", ""),
        merged_summary=c.get("summary", ""), merged_credibility=c.get("credibility", 60),
        merged_bias_flags=c.get("bias_flags", []), merged_relevance=c.get("relevance", 70),
        merged_date=c.get("date", ""), merged_clue_type=c.get("clue_type", "event"),
        merged_domain_tags=c.get("domain_tags", []), merged_parties=c.get("parties", []),
        source_clue_ids=[c["id"]], action="keep", reason="Unique clue — no duplicates found",
    )


def cleanup_propose(topic_title: str, clue_inputs: list[dict], parties: list[dict]) -> list[ClueGroup]:
    """Two-pass cleanup (⇄ runCleanupPropose). Pass 1: batched (40) CleanupScan over an index.
    Pass 2: single-id garbage → auto-delete (no LLM); the rest → CleanupResolve per candidate, with
    a cover-check (uncovered ids → keep) and consolidation_type tagging on merge groups. Untouched /
    unhandled clues auto-keep. BOUNDED: ceil(N/40) scan calls + <=C resolve calls."""
    clue_map = {c["id"]: c for c in clue_inputs}

    # Pass 1 — index scan, batched
    index_lines = []
    for c in clue_inputs:
        excerpt = (c.get("summary", "") or "")[:100].replace("\n", " ")
        prs = ", ".join(c.get("parties", [])) if c.get("parties") else "none"
        index_lines.append(
            f'[{c["id"]}] "{c.get("title", "")}" ({c.get("date", "")}, {c.get("clue_type", "")}) '
            f'| parties: {prs} | "{excerpt}..."'
        )
    BATCH = 40
    candidates: list[ScanCandidate] = []
    scan = dspy.ChainOfThought(CleanupScan)
    for i in range(0, len(index_lines), BATCH):
        batch = "\n".join(index_lines[i:i + BATCH])
        try:
            candidates.extend(scan(topic_title=topic_title, clue_index=batch).candidates or [])
        except Exception:  # noqa: BLE001
            continue

    if not candidates:
        return [clue_to_keep_group(c) for c in clue_inputs]

    candidate_ids = {cid for cand in candidates for cid in cand.ids}

    # Pass 2 — resolve
    auto_deleted: set[str] = set()
    resolve_groups: list[ClueGroup] = []
    resolve = dspy.ChainOfThought(CleanupResolve)

    for cand in candidates:
        if len(cand.ids) == 1 and cand.type == "garbage":
            c = clue_map.get(cand.ids[0])
            if c:
                auto_deleted.add(c["id"])
                g = clue_to_keep_group(c)
                g.action = "delete"
                g.reason = cand.reason
                resolve_groups.append(g)

    to_resolve = [c for c in candidates if not (len(c.ids) == 1 and c.type == "garbage")]
    for cand in to_resolve:
        group_clues = [clue_map[i] for i in cand.ids if i in clue_map]
        if not group_clues:
            continue
        detail = "\n\n---\n\n".join(
            f'[{c["id"]}]\nTitle: {c.get("title", "")}\nDate: {c.get("date", "")}\n'
            f'Type: {c.get("clue_type", "")}\nParties: {", ".join(c.get("parties", []))}\n'
            f'Credibility: {c.get("credibility", "")}\nRelevance: {c.get("relevance", "")}\n'
            f'Summary: {c.get("summary", "")}'
            for c in group_clues
        )
        try:
            result = resolve(topic=topic_title, suspicion_type=cand.type, reason=cand.reason,
                             clue_detail=detail).groups
        except Exception:  # noqa: BLE001
            result = None
        if not result:
            resolve_groups.extend(clue_to_keep_group(c) for c in group_clues)
            continue
        covered = {cid for g in result for cid in g.source_clue_ids}
        extra = [clue_to_keep_group(c) for c in group_clues if c["id"] not in covered]
        ct = None if cand.type == "garbage" else cand.type
        for g in result:
            if g.action == "merge":
                g.consolidation_type = ct
        resolve_groups.extend(result)
        resolve_groups.extend(extra)

    handled = set(auto_deleted) | {cid for g in resolve_groups for cid in g.source_clue_ids}
    auto_kept = [clue_to_keep_group(c) for c in clue_inputs
                 if c["id"] not in handled and c["id"] not in candidate_ids]
    still_unhandled = [clue_to_keep_group(c) for c in clue_inputs
                       if c["id"] in candidate_ids and c["id"] not in handled]
    return resolve_groups + auto_kept + still_unhandled


def smart_chunk(content: str, target_chars: int = 2000, max_chars: int = 4000) -> list[str]:
    """Split raw content into context-sized chunks (⇄ smartChunk regex chunker)."""
    import re
    raw = re.split(
        r"\n{2,}|\n(?=\*\s|\-\s|\d{4}[-/]\d{2}|#{1,3}\s|Mar |Feb |Jan |Apr |May |Jun |Jul |Aug |Sep |Oct |Nov |Dec )",
        content,
    )
    blocks = [s.strip() for s in raw if len(s.strip()) > 20]
    chunks: list[str] = []
    current = ""
    for block in blocks:
        if not current:
            current = block
        elif len(current) + len(block) + 2 <= max_chars:
            current += "\n\n" + block
            if len(current) >= target_chars:
                chunks.append(current)
                current = ""
        else:
            chunks.append(current)
            current = block
    if current:
        chunks.append(current)
    return chunks

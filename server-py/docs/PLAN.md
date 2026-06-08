The facts are confirmed: 10 SSE event types, the `STATUS_ORDER` gate, the relative `/api` base + Vite proxy to `:3000`, the live 32MB `dana.db`, and the proxy at `:8317`. The per-subsystem designs are accurate against the codebase. Now I'll synthesize the unifying architecture document.

# Dana-py: Python + DSPy, STORM-powered rewrite — Architecture & Roadmap

## Executive summary

Dana-py is a ground-up reimplementation of Dana's geopolitical scenario-analysis backend in **Python + FastAPI + DSPy**, built STORM-first and living in a new `server-py/` directory inside the existing repo. The React frontend and git history stay; the current TS/Bun/Elysia backend keeps running until parity cutover. The two backends share one `data/dana.db` (a live 32 MB SQLite file) and one CLIProxyAPI instance (`:8317`), so the migration is incremental and reversible, never a big-bang rewrite.

The thesis is that almost every fragile or hand-rolled seam in the TS backend maps onto a first-class DSPy construct. The ~12 hand-written `JSON.parse(raw.match(/\{...\}/))` blocks and `ScenarioScorer`'s manual 3× parse-retry collapse into **typed `dspy.Signature` output fields** that the adapter parses, coerces, and validates. The `runAgenticLoop` tool-calling loop becomes **`dspy.ReAct`** over `web_search`/`fetch_url`. The five gated pipeline stages become composable **`dspy.Module`s**. And — the strategic payoff — Dana's existing Brier/log-score resolution data (`forecast_resolutions`) becomes a labeled trainset that **`MIPROv2` compiles the scorer against**, turning prompt tuning from hand-editing `.md` files into a measured, regression-tested optimization loop closed on realized forecast accuracy.

STORM-first means the upstream research engine (Discovery + Enrichment) is rebuilt from day one as persona-driven, search-grounded conversations feeding a dynamic knowledge mind-map — but adapted to Dana's **adversarial** frame: STORM personas are neutral Wikipedia editors; Dana personas **are the contending parties and analytical lenses**, and their conversations emit Dana clues (not prose), which flow into the unchanged forum debate, weighted scoring, and calibration machinery. Three load-bearing porting rules govern the whole effort: (1) every regex-JSON parse becomes a typed `OutputField`; (2) every numeric/graph computation already outside the LLM call — pentagon power score, speaking-budget math, evidence map, independence clustering, ensemble aggregation, probability normalization, supervisor bookkeeping — **stays pure Python and is never LLM'd**; (3) the optimizable surface is narrow and deliberate: the **scorer, fact-check, and chairman** signatures, plus the base-rate retriever, compiled against calibration data.

## One-screen system architecture

```
React frontend (UNCHANGED)  ── relative "/api" + EventSource("/api/topics/:id/stream")
        │   vite dev-proxy → :3001 (one-line flip);  prod reverse-proxy /api → :3001
        ▼
┌─────────────────────────────────────────────── FastAPI app (dana.main, uvicorn :3001) ──────────────┐
│                                                                                                       │
│  api/ ── routers 1:1 with TS routes/ (same paths, methods, query params, JSON field names)            │
│   topics parties clues pipeline forum expert_council calibration settings prompts providers stream    │
│      │                         │                                            ▲                          │
│      │ POST /pipeline/*        │ GET /stream (text/event-stream)            │ emit(topic_id, Event)     │
│      ▼                         ▼                                            │ (sync, put_nowait)        │
│  runner/RunRegistry  ──spawn──► asyncio.Task (one run/topic, 409 guard)    │                          │
│      │  asyncio.Lock                    │                            events/bus.py                      │
│      ▼                                  ▼                  per-topic {asyncio.Queue}; 15s ping          │
│  pipeline/ gated stages ── state_manager (versioning/forking) · checkpoints (resumable)               │
│   ┌───────────┬────────────┬───────────────┬──────────────┬───────────────────┐                       │
│   │ DISCOVERY │ ENRICHMENT │  FORUM-PREP    │    FORUM     │     SCORING       │  (gated, reviewable)  │
│   │           │            │ (weights/      │ (adversarial │ (expert council)  │                       │
│   │  ◄──────── STORM research engine ──────►│  multi-party │                   │                       │
│   │  personas(parties/lenses) → grounded    │  debate)     │ Pass1: evidence   │                       │
│   │  conversation → knowledge tree →        │ orchestrator │  map (pure Py)    │                       │
│   │  gap-critic → clue emission             │ +supervisor  │ Pass2: DSPy scorer│                       │
│   └───────────┴────────────┴───────────────┴──────────────┴───────────────────┘                       │
│        │ each agent = dspy.Module over typed Signature; pure-Python math at the seams                  │
│        ▼                                                                                               │
│  llm/ ── dspy.LM("openai/<model>", api_base=PROXY/v1) ── resolve_available_model · rate-limit · retry  │
│        │            (steering as InputField · editable .md → Signature.with_instructions)              │
│  tools/ web_search (SearXNG→Brave) · http_fetch (Firecrawl→Jina→readability) · corpus cache            │
│  rigor/ dedup · base_rates · ensemble+bands · Brier/log calibration   optimize/ datasets·metrics·MIPRO │
└───────────────────────────────────────────────────────┬───────────────────────────────────────────────┘
        │ async SQLAlchemy (aiosqlite) Core, JSON-as-TEXT │ litellm                       │ offline CI job
        ▼ WAL · FK on · single-writer discipline           ▼                               ▼
   data/dana.db  (SHARED with TS backend, byte-compatible)  CLIProxyAPI :8317 ──► providers   data/dspy/<module>/<hash>.json
                                                            /v0/management (OAuth+custom)      → dspy_compiled_programs
```

## Cross-cutting design decisions

These are the decisions every subsystem depends on; the per-subsystem designs above elaborate each in depth.

**1. The frontend is the immovable contract.** The React app calls a relative `/api` (confirmed `const BASE = "/api"`) and a bare `EventSource` with `es.onmessage` (no named SSE events). This pins everything downstream: Python must reproduce paths, methods, query params, and **JSON field names verbatim** (the camelCase/snake mix as-is — `run_id`, `started_at`, `weight_factors`, `scenarios_ranked`), and must emit the same 10 unnamed `data:`-line event types (`think|progress|forum_turn|expert_assessment|verdict_content|weight_result|clue_discovered|stage_complete|error|ping`, confirmed in `stream.ts`). "Point the frontend at Python" is therefore a one-line Vite flip in dev (`:3000`→`:3001`) and a reverse-proxy target change in prod — zero frontend code changes. Golden contract tests (`tests/contract/`) recording live TS responses are the literal definition of parity.

**2. DSPy is the agent substrate; pure Python owns the math.** Every agent becomes a `dspy.Module` over a Pydantic-typed `Signature`, but the boundary between LLM judgment and deterministic computation is drawn **exactly where the TS code already draws it**. `ScenarioScorer`'s Pass-1 `buildEvidenceMap`/`independentDensity` (the evidence-independence clustering, keyed on primary domain only — not union-on-shared-domain, which would make the scorer under-confident), the pentagon power-score area formula, the speaking-budget pools, ensemble aggregation, probability normalization, and the supervisor's turn-distribution/loop-detection bookkeeping all stay as plain functions over Pydantic models. Porting these to LLM calls would be a correctness regression. This rule (Foundations §1/§4, Pipeline rule 2, Rigor §1) is what keeps the rewrite reproducible.

**3. CLIProxyAPI stays; DSPy reaches it through litellm with Dana's availability fallback in front.** `dspy.LM("openai/<model>", api_base=PROXY_BASE_URL+"/v1", api_key=...)` routes all traffic through the existing proxy (`:8317`), preserving OAuth/custom-provider management via `/v0/management`. DSPy has no equivalent of `resolveAvailableModel`, so a thin `dspy.LM` shim (`llm/lm.py`) ports `modelCatalog.ts`'s resolution and applies it **before** constructing the LM, plus the per-model `aiolimiter` token buckets (opus 2 rps, sonnet 5 rps) and `tenacity` backoff — so a disconnected provider transparently degrades to a same-tier available model on every DSPy call, exactly as `chatCompletion` does today.

**4. Async + SSE share one event loop; stay in-process.** Pipeline runs are `asyncio.create_task` (fire-and-forget, returning `{run_id, started_at, status:"started"}` immediately, matching the TS `.then()/.catch()` pattern). A `RunRegistry` with an `asyncio.Lock` enforces one-run-per-topic and closes the check-then-set race the TS `Map` left open, returning 409 on conflict. The SSE bus is a per-topic `{asyncio.Queue}` pub/sub; `emit()` is **synchronous and non-blocking** (`put_nowait`, drop-on-full) so agent code calls it like the TS `emit`/`emitThink` with no `await` threaded through. The deliberate recommendation across two subsystems is **not** to adopt Celery/arq — a separate worker process would need Redis just to ferry events back to the web process, replacing today's zero-dependency in-memory bus, and the pipeline is one long human-cadence run per topic, not high-throughput fan-out. The seam is preserved: swap `TopicBus`→Redis pub/sub and `RunRegistry`→Redis lock later if horizontal scale is ever needed, with call sites unchanged. DSPy's `BaseCallback` emits `think` events on every LM/tool call, reproducing `emitThink` granularity without instrumenting each agent; `streamify` + `StreamListener` covers token-level streaming where wanted.

**5. Reuse `dana.db` as-is via async SQLAlchemy Core — zero migration.** Both backends read/write the same file during the migration window, so the schema must stay byte-compatible: same 22 table/column names, same JSON-in-`TEXT` columns (a `JSONText` TypeDecorator round-trips to the same TEXT `JSON.stringify` writes), same `PRAGMA journal_mode=WAL`/`foreign_keys=ON`. Core (not full ORM/SQLModel) is chosen because the schema is heavily JSON-in-TEXT with composite PKs (`parties(id, topic_id)`, `clue_versions(clue_id, topic_id, version)`) that map cleanly and match the existing hand-rolled query style. SQLite's one-writer rule is handled by extending the run-registry's "one run per topic" into a cross-process advisory lock (`app_settings` row `pipeline_owner:<topic_id>`); reads are unrestricted. Python's only new tables (`dspy_compiled_programs`, eval runs) come via an Alembic migration that **only** `CREATE TABLE dspy_*` and never touches TS-owned tables. The version-snapshot logic (clues/parties/reps served from `*_snapshot` for completed versions, gated on `completed_stages`) is ported field-for-field so `?version=` queries keep working.

**6. Editable `.md` prompts and DSPy Signatures are reconciled, not in conflict.** The `.md` file becomes the Signature's **instruction string** (`Signature.with_instructions(load_prompt(name))`), not a replacement for the Signature's typed I/O contract. A prompt keeps three editable layers, all preserved by the existing `/api/prompts` CRUD: instructions (`.md` body), model (`prompt_configs.model` → task-profile default → `resolve_available_model`), and tools (`prompt_configs.tools` selecting `dspy.ReAct(tools=...)` vs `dspy.Predict`). `{var}` placeholders fill before the string becomes the instruction. Crucially, this is also the optimization hook: an optimizer's improved instruction string writes **back** to the same `.md` (with existing backup/reset machinery), so human editing and machine optimization share one artifact — keeping the "operators still tune behavior" contract while making prompts first-class optimization targets.

## How a request flows through the system

A pipeline stage exercises every layer; tracing one shows how the subsystems interlock:

1. **Request → gate → run.** `POST /api/topics/:id/pipeline/enrich` hits `api/pipeline.py`. It loads the topic, checks the ordered status gate (`status_at_least(topic.status, "review_parties")` — a port of the `STATUS_ORDER` array), and asks `RunRegistry.start()` under its lock. On conflict → 409 `{message, running, run}`; otherwise an `asyncio.Task` is spawned and `{run_id, started_at, status:"started"}` returns immediately.

2. **Stage → STORM/agents → DSPy.** The stage coroutine (`pipeline/stages.py`) drives the relevant modules. For Enrichment that's the STORM engine: per-persona (party/lens) `AnalystResearcherConversation`s run in bounded parallel (`asyncio.gather` + `Semaphore`), each a `dspy.Predict(AskAsParty)` ↔ `GroundedResearcher` loop where the researcher answers **only** from retrieval and refuses to hallucinate (`INSUFFICIENT_EVIDENCE`). Turns insert into the shared `KnowledgeBase` tree; a `GapCritic` every N turns injects coverage gaps back into analysts to hunt thin party×lens cells and disconfirming evidence.

3. **DSPy → CLIProxyAPI.** Each LM call goes through the `dspy.LM` shim: `resolve_available_model` picks a served model, the per-model rate limiter gates it, litellm sends an OpenAI-compatible request to `:8317/v1`, the typed `OutputField` parses/coerces the response (no regex), and `Refine`/`BestOfN` retries on **semantic** invalidity (probabilities out of range, evidence-independence violations).

4. **Tools → corpus → DB.** `web_search`/`fetch_url` (wrapped Python functions, docstring = tool description) hit SearXNG→Brave and Firecrawl→Jina→readability, but first consult the corpus cache (`research_searches`/`research_pages`) so concurrent conversations dedupe fetches — the biggest real-world token saving.

5. **Emission → DB → SSE.** Each grounded turn distills into a Dana `ClueVersion` (matching `storeClue.ts` exactly), runs evidence-independence dedup + adversarial fact-check, and writes `clues`/`clue_versions`. Throughout, agents call `emit(topic_id, ...)` → the `TopicBus` `put_nowait`s to every subscriber queue → the `/stream` generator yields `data: {json}\n\n` to the unchanged `EventSource`. The `think`/`progress`/`clue_discovered`/`stage_complete` sequence matches `gatedPipeline.ts` turn-for-turn.

6. **Gate close → version → checkpoint.** On success the stage writes a checkpoint, `mark_stage_complete` snapshots state into the version row, status transitions to `review_enrichment`, and the run handle clears. Downstream, Forum hands each `RepresentativeAgent` its party's clue subset (`party_relevance` filter) + the relevant knowledge subtree; the `ScenarioScorer` consumes verified clues + base-rate anchors from the Phase-1 analogous cases (reference-class forecasting) + the gap-critic's disconfirming evidence; resolutions later feed the optimizer.

## Key risks & tradeoffs of going DSPy/Python

- **DSPy version churn.** DSPy moves fast and has had breaking renames (`Assert`/`Suggest`→`Refine`/`BestOfN` in 2.6; evolving `settings`/`configure`; `ReActV2` in 3.3+; compiled-artifact format changes). The two subsystem analyses even cite slightly different targets — **pin one known-good version** (`dspy>=3.0,<3.4`) in `pyproject.toml`, commit `uv.lock`, and treat streaming/async/native-tool-calling as maturing surfaces with the documented fallbacks (`ChatAdapter` text-parse when a proxied model's native tool-calls are flaky, matching the existing `supports_tools` flag).

- **Streaming and async are async-first and less-exercised.** The SSE "think" feed depends on `streamify`/callbacks under FastAPI; the sync generator path (`async_streaming=False`) is the less-tested route. Mitigation: prefer the async route, and the `BaseCallback` path gives stage-level progress without restructuring streams. The non-blocking `put_nowait` bus means a slow SSE client can only drop events, never stall a run.

- **Optimizer cost/credit-assignment.** Optimizers make real (costly, slow) LM calls and the Brier reward is **distal** — research quality is several hops from forecast accuracy. Mitigation: optimize scorer and research **separately** (research against proxy metrics — coverage of resolution criteria, independent-cluster count; scorer against Brier end-to-end), gate compilation behind an offline CI job, compile at ensemble `n=1` then wrap the compiled predictor in the production ensemble, and cache aggressively.

- **Cold-start calibration data.** Resolutions are scarce early. Mitigation: leave-one-out/k-fold over all resolved topics (no fixed split, stratified so no topic leaks), `BootstrapFewShot` below ~15-30 resolutions, graduate to `MIPROv2` at scale; the harness surfaces "insufficient calibration data" rather than failing. The loop strengthens automatically as analysts resolve topics via the existing `/api/topics/:id/resolve`.

- **Two backends, one SQLite file.** WAL handles concurrent readers + one writer, but two writers to the same topic would corrupt state. Mitigated by the cross-process `pipeline_owner` advisory lock and the discipline of routing a topic's pipeline to exactly one backend at a time. The byte-compatible JSON-as-TEXT contract is the other risk surface — covered by round-trip tests that assert a Python-written row reads identically in the still-running TS backend.

- **Steerability under optimization (safety).** A naive optimizer could learn to obey conclusion-forcing operator guidance. Mitigated structurally: steering enters as a **runtime `InputField`** (never baked into the optimizable instruction), the guardrail wrapper is re-asserted post-text, and an **adversarial-steering regression probe** in the eval harness fails any compiled program whose Brier degrades under conclusion-forcing steering vs neutral — making the epistemic-only contract a measured, non-regressing property.

- **Loss of parity from subtle reimplementation drift.** The deepest risk is silent behavioral divergence in the ~12 parsers, the evidence-map math, and the supervisor guardrails. Mitigated by the 1:1 file-mapping rule (every `*.ts` agent/route has a named Python home so reviewers diff behavior file-by-file), byte-identical ports of calibration math, and the golden contract + SSE-sequence tests.

## Consolidated phased roadmap

The two subsystem roadmaps agree on a STORM-first sequence; this is the unified version. Each phase is independently demoable against the unchanged frontend via the one-line Vite flip.

**Phase 0 — Scaffold + plumbing + trivial endpoints.** `server-py/` skeleton (uv, pinned `pyproject`/`uv.lock`, `config.py`), `db/engine.py` + reflected `models.py` + `JSONText`, the `dspy.LM`→proxy shim with availability-fallback and rate-limit, `events/bus.py`, `api/stream.py`, and `GET /api/topics` + `GET/POST /api/topics/:id` + `GET /api/settings` reading the real `dana.db`.
**Accept:** boots on `:3001`; `GET /api/topics` returns JSON **identical** to TS for the same DB (contract test green); SSE connects, emits `ping`, a manual `emit()` reaches a subscriber; one Vite-flip renders the React topic list unchanged; `dspy.LM` round-trips a completion through CLIProxyAPI with fallback proven (kill a provider → substitution logged).

**Phase 1 — STORM research engine (Discovery + Enrichment) → clues.** `research/{personas,conversation,retriever,curate,mindmap}`, `tools/{web_search,http_fetch,corpus}`, `agents/{discovery,enrichment}`, `pipeline/{runner,stages,state_manager,checkpoints}` for the first two gates, `api/pipeline.py` (`discover`/`enrich`/`status`), `api/parties.py`, `api/clues.py` (read + core CRUD).
**Accept:** `POST /pipeline/discover` runs persona-driven, search-grounded STORM discovery, writes `parties` (same columns/types), transitions to `review_parties`; `enrich` produces grounded, cited, deduped clues (a no-source test invents **no** clue — refuse-to-hallucinate verified); SSE emits `progress`/`think`/`clue_discovered`/`stage_complete` matching TS shapes; corpus cache hits work; React Discovery→Parties→Clues→knowledge-map views render against Python with **no frontend change**; versioning/forking `/states` matches.

**Phase 2 — Forum + Scoring parity.** `agents/{weight_calculator,forum_orchestrator,forum_supervisor,representative,scenario_scorer,expert}`, remaining `pipeline/stages` gates, `api/{forum,expert_council}.py`, pipeline endpoints `forum-prep/forum/score/analyze/reanalyze/run`. Forum is the adversarial STORM core (scratchpads in parallel, turns sequential, supervisor bookkeeping pure-Python); Scoring is Pass-1 evidence map (pure Python) + Pass-2 DSPy ensemble scorer with uncertainty bands.
**Accept:** full `forum-prep → forum → score` runs to `complete`; `forum_*`, `representatives`, `expert_councils/assessments/final_verdicts` rows match TS shapes; `forum_turn`/`expert_assessment`/`weight_result`/`verdict_content` SSE events match; `GET /forum`, `/representatives`, `/expert-council`, `/verdict` render unchanged; a full pipeline produces a ranked verdict the React Forum/Verdict tabs display unchanged.

**Phase 3 — Calibration + steering + providers + DSPy optimization.** `rigor/{dedup,base_rates,ensemble,calibration}` (Brier/log ported byte-identical), `api/{calibration,providers,prompts}.py` + `providers/custom`, `llm/{steering,proxy_admin,prompt_loader}`, `optimize/{datasets,metrics,compile}`, eval CI with A/B compare + guardrail regression + ablations.
**Accept:** `/api/calibration`, `/resolve`, `/resolution` reproduce Brier/log numbers **identical** to TS; provider list/OAuth-connect/disconnect/custom-provider drive the same `/v0/management` API and reflect live credential state (never echoing key-bearing response bodies); steering blocks influence research/evidence/debate as method-not-conclusion with the guardrail probe passing; `optimize/compile.py` produces a compiled scorer that **improves held-out Brier** vs the base program, loaded at startup, eval split guarded in CI.

**Phase 4 — Cutover.** Route `/api → :3001` (compose reverse-proxy), run both backends under shadow traffic, then remove the `dana` (TS) service; optionally split CLIProxyAPI into its own compose service so Python no longer depends on the TS container.
**Accept:** full contract-test suite green across **every** endpoint + SSE; a clean end-to-end topic (create → discover → enrich → analyze → score → resolve → calibration) runs entirely on Python producing equal-or-better results; frontend unchanged and pointed only at Python; TS container deleted; `data/dana.db` continuity preserved (no data migration).

---

**Relevant grounding files** (all absolute): pipeline `/home/nima/dana/app/backend/src/pipeline/{gatedPipeline,stateManager,checkpointManager}.ts`; agents `/home/nima/dana/app/backend/src/agents/{DiscoveryAgent,DiscoveryResearcher,PartyScorer,EnrichmentAgent,PartyEnrichmentAgent,FactCheckAgent,WeightCalculator,ForumOrchestrator,ForumSupervisor,RepresentativeAgent,ScenarioScorer}.ts`; LLM/tools `/home/nima/dana/app/backend/src/llm/{proxyClient,modelCatalog,agenticLoop,steering,promptLoader}.ts`, `/home/nima/dana/app/backend/src/tools/external/{webSearch,httpFetch}.ts`; DB+routes `/home/nima/dana/app/backend/src/db/database.ts`, `/home/nima/dana/app/backend/src/routes/{stream,pipeline,topics,calibration,providers,forum,settings,prompts}.ts`; frontend `/home/nima/dana/app/frontend/{vite.config.ts,src/api/client.ts}`; deploy `/home/nima/dana/{docker-compose.yml,Dockerfile,entrypoint.sh}`; STORM refs `/home/nima/storm/knowledge_storm/storm_wiki/modules/{persona_generator,knowledge_curation}.py`, `/home/nima/storm/knowledge_storm/collaborative_storm/modules/{information_insertion_module,co_storm_agents,grounded_question_generation}.py`, `/home/nima/storm/knowledge_storm/dataclass.py`.

---

# Detailed subsystem designs

I have authoritative, current coverage of all eight required areas. Producing the focused markdown section now.

## DSPy Foundations

> **Version baseline:** DSPy **3.x** (current line; `3.3.0b1` introduced `ReActV2` and reworked `BaseLM`). API verified June 2026 against `dspy.ai` / `github.com/stanfordnlp/dspy`. Pin a known-good version (`dspy>=3.0,<3.4`) — DSPy moves fast and has had breaking renames (`dspy.Assert`/`Suggest` → `Refine`/`BestOfN` in 2.6; `dspy.settings`/`configure` semantics evolving). Treat **streaming, async, and adapter-native tool-calling as maturing surfaces** (caveats inline).

DSPy replaces Dana's "prompt string → LLM → `raw.match(/\{[\s\S]+\}/)` → `JSON.parse` → manual 3× retry" loop (see `DiscoveryAgent.ts:131`, `ScenarioScorer.ts:516-536`) with a declarative, typed, compilable program. The translation map for `server-py/`:

| Dana (TS) today | DSPy replacement |
|---|---|
| Hand-written prompt `.md` + JSON instructions | `dspy.Signature` (typed fields + docstring instructions) |
| `raw.match(...)` + `JSON.parse` | typed `OutputField` (Pydantic) — adapter parses & coerces |
| manual 3× parse-retry (`ScenarioScorer`) | `dspy.Refine` / `dspy.BestOfN` with a reward fn |
| `runAgenticLoop` (web_search/fetch_url tool loop) | `dspy.ReAct(tools=[...])` |
| `chatCompletion` + `resolveAvailableModel` fallback | `dspy.LM(...)` + wrapper that resolves model id before constructing the LM |
| `emitThink(...)` SSE feed | `dspy.streamify` + `StatusMessageProvider` / `StreamListener`, or a `BaseCallback` |
| token-bucket rate limit + `Promise.all` fan-out | `dspy.Parallel` / `module.batch(num_threads=...)` |
| prompt tuning by hand | `MIPROv2` / `BootstrapFewShot` compiled against Dana calibration data |

---

### 1. Signatures — typed I/O replacing JSON-regex parsing

Define the *contract*; the adapter handles serialization + parsing + type coercion. Use **class-based signatures with Pydantic output models** for every structured Dana agent.

```python
import dspy
from typing import Literal
from pydantic import BaseModel, Field

# Pydantic models = the schema Dana used to hand-write in prompts and regex back out.
class Party(BaseModel):
    name: str
    role: str
    stance: str = Field(desc="one-line summary of the party's position")
    leverage: float = Field(ge=0, le=1)

class DiscoverParties(dspy.Signature):
    """Identify the distinct adversarial parties relevant to a geopolitical
    forecasting topic. Each party must be an actor with agency over the outcome."""

    topic: str = dspy.InputField()
    context: str = dspy.InputField(desc="grounded notes gathered from research")
    parties: list[Party] = dspy.OutputField(desc="3-7 mutually-distinct actors")
    rationale: str = dspy.OutputField()

# Inline form is fine for throwaway/internal steps:
# dspy.Predict("topic, context -> queries: list[str]")
```

- Typed outputs (`list[Party]`, `Literal[...]`, `dict[str,list[str]]`, nested `BaseModel`) are **coerced and validated by the adapter** — no regex, no `JSON.parse`. On mismatch DSPy raises/warns instead of silently returning garbage.
- `desc=` on fields and the **docstring = instructions** are what optimizers later rewrite (§8).
- Runtime instructions: `dspy.Signature("comment -> toxic: bool", instructions="...")`.
- Adapter choice matters: `dspy.JSONAdapter` (default in 3.x) leans on native structured output / function-calling; `dspy.ChatAdapter` uses delimited text parsing. Configure per §3. **Caveat:** very deep/recursive Pydantic schemas can still confuse weaker models — keep output models shallow (Dana's `Party`/`Clue`/`ScenarioScore` are fine).

---

### 2. Modules — Predict / ChainOfThought / ReAct / custom `dspy.Module`

```python
discover  = dspy.Predict(DiscoverParties)          # raw structured prediction
weigh     = dspy.ChainOfThought("party_profile, evidence -> weight: float, reasoning")
# ChainOfThought auto-adds a `reasoning` output field (great for Dana's "think" feed).

resp = weigh(party_profile=p, evidence=ev)
resp.weight; resp.reasoning                        # Prediction object, named fields
```

Compose Dana's pipeline stages as custom modules (PyTorch-style; sub-modules are tracked params the optimizer can tune):

```python
class EnrichmentStage(dspy.Module):
    def __init__(self, tools):
        self.researcher = dspy.ReAct("party, topic -> findings: list[str]", tools=tools, max_iters=8)
        self.profiler   = dspy.ChainOfThought("party, findings -> profile: PartyProfile")
        self.factcheck  = dspy.Predict("profile, findings -> verified: PartyProfile, flags: list[str]")

    def forward(self, party: str, topic: str) -> dspy.Prediction:
        r = self.researcher(party=party, topic=topic)
        p = self.profiler(party=party, findings=r.findings)
        v = self.factcheck(profile=p.profile, findings=r.findings)
        return dspy.Prediction(profile=v.verified, flags=v.flags, trajectory=r.trajectory)
```

Each gated stage of `gatedPipeline.ts` (Discovery → Enrichment → ForumPrep → Forum → Scoring) becomes one such module; the orchestrator composes them and persists between gates. `MultiChainComparison` / `dspy.majority` are useful for Dana's **scoring ensemble + uncertainty bands** (Enh 4): run N reasoning paths, aggregate.

---

### 3. LM configuration → litellm → CLIProxyAPI, per-task models, availability fallback

CLIProxyAPI is OpenAI-compatible, so use the litellm `openai/` prefix with `api_base` pointed at the proxy (`PROXY_BASE_URL`, default `http://127.0.0.1:8317/v1`).

```python
import dspy

def make_lm(model_id: str, **kw) -> dspy.LM:
    return dspy.LM(
        f"openai/{model_id}",                  # e.g. openai/minimax-m3, openai/claude-...
        api_base=f"{PROXY_BASE_URL}/v1",
        api_key=PROXY_API_KEY or "sk-dummy",
        temperature=kw.pop("temperature", 0.7),
        max_tokens=kw.pop("max_tokens", 4096),
        cache=kw.pop("cache", True),
    )

dspy.configure(lm=make_lm("minimax-m3"))         # global default
```

**Per-task model selection** (mirrors Dana's `TaskProfile`/tiers) via thread-local `dspy.context`:

```python
DEEP = make_lm(resolve_available("claude-opus", profile="deep_reasoning"))
FAST = make_lm(resolve_available("haiku",       profile="fast"))

with dspy.context(lm=DEEP):                       # thread-safe, scoped
    verdict = scorer(scenario=s)
# or pin a sub-module permanently:
forum_chair.set_lm(DEEP)
```

**Model-availability fallback** — DSPy has no equivalent of `resolveAvailableModel`, so keep Dana's logic and apply it **before** constructing the `dspy.LM` (port `modelCatalog.ts` `resolveAvailableModel`/`resolveSmartDefault` to Python, fed by the proxy's `/v1/models` + verification cache from `proxyClient.ts`). Wrap construction so a disconnected provider transparently degrades to a same-tier available model. For OpenAI reasoning models behind the proxy, `model_type="responses"` may be needed. `lm.history[-1]` exposes prompt/usage/cost; enable `dspy.configure(track_usage=True)` and read `pred.get_lm_usage()` for the token budgeting `tokenBudget.ts` does today.

---

### 4. Output validation + retries → `Refine` / `BestOfN` (replaces manual parse-retry)

Replaces `ScenarioScorer`'s hand-rolled 3× parse loop. `BestOfN` runs the module up to N times (different `rollout_id`s) and returns the first passing `threshold` or the highest-reward attempt; `Refine` adds an auto-generated-feedback hint loop between attempts.

```python
def well_formed_score(args, pred: dspy.Prediction) -> float:
    s = pred.scenario_score
    ok = 0 <= s.probability <= 1 and len(s.drivers) >= 2 and s.uncertainty_band is not None
    return 1.0 if ok else 0.0

robust_scorer = dspy.Refine(
    module=dspy.ChainOfThought("scenario, evidence -> scenario_score: ScenarioScore"),
    N=3, reward_fn=well_formed_score, threshold=1.0,
)
```

- `reward_fn(args, pred) -> float` (higher = better); `fail_count` bounds tolerated errors.
- Parse failures rarely surface here at all — typed `OutputField` already enforces shape; `Refine`/`BestOfN` are for **semantic** validity (probabilities in range, calibration constraints, evidence-independence checks from Enh 4).
- **Caveat:** `dspy.Assert`/`dspy.Suggest` are **removed/deprecated** (since 2.6) — do not use; these two are the supported replacements.

---

### 5. Tool use / ReAct → the `web_search` + `fetch_url` agentic loop

`dspy.ReAct` replaces `runAgenticLoop`. Pass plain Python functions (docstring = tool description, type hints = arg schema, auto-derived).

```python
def web_search(query: str, num_results: int = 3, language: str | None = None) -> str:
    """Search the web (SearXNG, Brave fallback). Returns JSON list of {title,url,snippet,date}."""
    return json.dumps(searxng_search(query, num_results, language))

def fetch_url(url: str) -> str:
    """Fetch and extract main content of a page (Firecrawl → Jina → Readability)."""
    return json.dumps(http_fetch(url))

researcher = dspy.ReAct(
    "party, topic -> clues: list[Clue]",
    tools=[web_search, fetch_url],
    max_iters=10,                       # ≈ Dana's research budget / max_iterations
)
res = researcher(party=p, topic=t)
res.clues; res.trajectory               # trajectory = full thought/action/observation trace
```

- Wrap the tool bodies to keep Dana's **corpus caching** (`findSimilarSearches`/`getPage`/`storeSearch`/`storePage`) and per-tool caps — DSPy doesn't manage that; the function is your integration seam.
- `res.trajectory` gives the reasoning/tool trace to drive the SSE "think" feed (§7) and to log to `research_searches/pages`.
- Native function-calling vs. text-parsed tool calls is adapter-controlled: `dspy.ChatAdapter(use_native_function_calling=True)` or `JSONAdapter(...)`. **Caveat:** not every proxied model supports native tool calls cleanly — keep `ChatAdapter` text-parse as the safe fallback, matching the `supports_tools` flag already in `modelCatalog.ts`.
- Async tools: `dspy.Tool(async_fn)` + `researcher.acall(...)` runs tools concurrently (§6). `ReActV2` (3.3+) is the newer impl — pin and test.

---

### 6. Async + concurrency + caching (many agents in parallel)

Dana fans out parties with `Promise.all` + a token bucket. DSPy gives two paths:

**Async** — implement `aforward` / call `acall`:
```python
class EnrichmentStage(dspy.Module):
    async def aforward(self, party, topic):
        r = await self.researcher.acall(party=party, topic=topic)
        p = await self.profiler.acall(party=party, findings=r.findings)
        return dspy.Prediction(profile=p.profile)

results = await asyncio.gather(*[stage.acall(party=p, topic=t) for p in parties])
```
This fits FastAPI's async handlers directly.

**Thread-parallel** — `dspy.Parallel` / `module.batch`:
```python
parallel = dspy.Parallel(num_threads=8, timeout=120)
results = parallel([(stage, dspy.Example(party=p, topic=t).with_inputs("party","topic"))
                    for p in parties])
# or: stage.batch(examples, num_threads=8)
```

- **Concurrency control:** DSPy has no token bucket — keep Dana's per-tier rate limiting either inside the LM wrapper (semaphore/bucket around the litellm call) or by bounding `num_threads` per tier. Don't lose the `opus rps=2 / sonnet rps=5` policy from `proxyClient.ts`.
- **Caching:** `dspy.LM(..., cache=True)` (default) caches identical requests — disable per-call with `cache=False`, or force a fresh sample with `rollout_id=k, temperature>0` (this is how `BestOfN` gets N distinct samples). Cached calls don't increment `track_usage`.

---

### 7. Streaming / callbacks → the SSE "think" feed

Two complementary mechanisms reproduce `emitThink`/`emitThink`-style SSE:

**`streamify` + listeners** (token + status stream, async-native):
```python
stream_stage = dspy.streamify(
    EnrichmentStage(tools),
    stream_listeners=[dspy.streaming.StreamListener(signature_field_name="reasoning",
                                                    allow_reuse=True)],   # reuse for ReAct loops
    status_message_provider=DanaStatus(),
)
async for chunk in stream_stage(party=p, topic=t):
    if isinstance(chunk, dspy.streaming.StatusMessage):  sse_emit_think(topic_id, chunk)
    elif isinstance(chunk, dspy.streaming.StreamResponse): sse_emit_token(topic_id, chunk.chunk)
    elif isinstance(chunk, dspy.Prediction):              final = chunk
```
```python
class DanaStatus(dspy.streaming.StatusMessageProvider):
    def tool_start_status_message(self, instance, inputs):  # → 🔎 "Searching ..."
        return f"{instance.name}({inputs})"
    def lm_start_status_message(self, instance, inputs):     # → 🤔 "thinking"
        return "reasoning…"
```
Map these to the existing SSE event shapes so the **React frontend is unchanged**.

**`BaseCallback`** — lower-level hooks (`on_module_start/end`, `on_lm_start/end`, `on_tool_start/end`) registered globally via `dspy.configure(callbacks=[...])`; good for stage-level progress + writing to `research_*` tables without restructuring the stream. **Caveat:** streaming is async-first; `async_streaming=False` gives a sync generator but is the less-exercised path — prefer the async route under FastAPI/SSE.

---

### 8. Optimizers + save/load → real eval loop on Dana calibration data

DSPy compiles a program (instructions + few-shot demos, or weights) against a `trainset` + `metric`. This is where Dana's **Brier/log-score calibration + forecast resolutions** (`db/queries/calibration.ts`, `forecast_resolutions`) become training signal.

```python
# 1. Build trainset from resolved forecasts (input = scenario+evidence, label = realized outcome)
trainset = [
    dspy.Example(scenario=r.scenario, evidence=r.evidence, outcome=r.resolved)
        .with_inputs("scenario", "evidence")
    for r in resolved_forecasts
]

# 2. Metric = calibration score (lower Brier better → invert to higher-is-better)
def brier_metric(example, pred, trace=None) -> float:
    return 1.0 - (pred.scenario_score.probability - example.outcome) ** 2

# 3. Compile (MIPROv2: Bayesian instruction + few-shot search)
tele = dspy.MIPROv2(metric=brier_metric, auto="medium")
compiled_scorer = tele.compile(ScenarioScorerModule(), trainset=trainset)

# 4. Persist / reload the compiled artifact
compiled_scorer.save("artifacts/scorer.v3.json")
scorer = ScenarioScorerModule(); scorer.load("artifacts/scorer.v3.json")
```

- **Optimizer selection:** `BootstrapFewShot` (~10 ex), `BootstrapFewShotWithRandomSearch` (50+), `MIPROv2` (200+ ex / instruction+few-shot, the workhorse), `GEPA` (reflective prompt evolution), `BootstrapFinetune`/`BetterTogether` (weight-level, only if a small local model is served). `COPRO`/`SIMBA` for instruction-only.
- **Data needed:** `list[dspy.Example]` with `.with_inputs(...)` marking inputs; everything else is the label. A `metric(example, pred, trace=None) -> float`. Dana already produces the gold signal (resolved outcomes + Brier/log-score) — wire `forecast_resolutions` straight in.
- **Eval loop:** `dspy.Evaluate(devset=..., metric=brier_metric, num_threads=8)` for held-out scoring; version compiled artifacts (`scorer.v3.json`) in the repo/DB and select per-stage like prompt configs are versioned today (`prompt_configs`).
- **Caveat:** optimizers make real LM calls (cost/time) — gate behind an offline job, cache aggressively, and pin the DSPy version since the compiled-artifact format and optimizer names change across releases.

---

**Net:** standardize every Dana agent as a `dspy.Module` over a **Pydantic-typed `Signature`**, run it on a CLIProxyAPI-backed `dspy.LM` selected per task (with Dana's availability fallback in front), wrap web research in `dspy.ReAct`, harden outputs with `Refine`/`BestOfN`, fan out with `acall`/`Parallel`, drive SSE via `streamify`+callbacks, and close the loop by compiling the scorer/weights against Dana's calibration data with `MIPROv2`.

Relevant source files studied: `/home/nima/dana/app/backend/src/llm/proxyClient.ts`, `/home/nima/dana/app/backend/src/llm/modelCatalog.ts`, `/home/nima/dana/app/backend/src/llm/agenticLoop.ts`, `/home/nima/dana/app/backend/src/agents/DiscoveryAgent.ts` (brittle parse at line 131), `/home/nima/dana/app/backend/src/agents/ScenarioScorer.ts` (manual 3× parse-retry at lines 516-536).

---

I now have a complete and precise picture of every agent, the gated pipeline, versioning/forking, checkpointing, the forum data model, and the STORM DSPy patterns. Here is the deliverable.

---

## Pipeline & Agent Mapping

This maps every Dana TS agent (`app/backend/src/agents/*.ts`) and the gated 5-stage pipeline (`pipeline/gatedPipeline.ts`) to concrete DSPy modules/signatures for `server-py/`. Conventions below.

**DSPy version note:** target `dspy>=2.5` (uses `dspy.Module`, `dspy.Signature`, `dspy.ChainOfThought`, `dspy.Predict`, `dspy.ReAct`/`dspy.Tool`, typed `OutputField` via `pydantic` models, `dspy.Suggest`/assertions, and the `dspy.teleprompt` optimizers MIPROv2/BootstrapFewShot). `dspy` is **not installed locally** — pin it in `server-py/pyproject.toml`.

### 0. Foundational layer (what every agent module sits on)

| TS concept | server-py module | Notes |
|---|---|---|
| `proxyClient.chatCompletionText` | `server_py/llm/lm.py` → `dspy.LM("openai/<model>", api_base=CLIPROXY_URL)` | One `dspy.LM` per model; `resolveAvailableModel` fallback wrapped as a custom `dspy.LM` subclass that retries on the management-API model list. |
| `agenticLoop.ts` (web_search + fetch_url + corpus cache, per-round caps, research budget, context-warning compaction) | `server_py/llm/research_tools.py` exposing `dspy.Tool`s `web_search`, `fetch_url`, `store_clue`; driven inside agents via `dspy.ReAct(sig, tools=[...], max_iters=N)` | The TS agentic loop becomes a DSPy `ReAct` module. Corpus cache (SearXNG/Brave + Firecrawl→Jina→Readability) stays a tool-level concern, not the LM's. Per-round caps + `contextWarningThreshold` → `max_iters` + a `dspy.Tool` wrapper that short-circuits when budget exceeded. |
| `resolvePrompt` (.md prompt files) + `budgetOutput`/`fitContext` | `server_py/llm/signatures.py` (docstrings = system prompt) + `server_py/llm/context.py` | Editable prompts become **Signature docstrings + instructions**; `dspy.Predict(sig).signature.with_instructions(loaded_md)` lets operators still hot-edit. This is the big win: prompts become optimizable artifacts, not just `.md` files. |
| `steering.ts` (`steeringBlock`, guardrailed analyst guidance) | `server_py/llm/steering.py` → injected as an extra `InputField guidance: str` on research/evidence/debate signatures, with the guardrail preamble kept verbatim | Keep epistemic-only contract. As an `InputField`, it's visible to optimizers but never optimized away. |
| `parseWithRetry` + `JSON.parse(raw.match(/\{...\}/))` everywhere | **Deleted.** Typed `OutputField`s on pydantic models | DSPy's adapter handles structured parsing + retry. Eliminates ~every `parseWithRetry`/regex-extract block in the TS (Discovery, Enrichment, FactCheck, Supervisor, Scorer all hand-roll this). |
| `emit` / `emitThink` SSE | `server_py/stream/bus.py` (per-topic `asyncio.Queue`) + a `dspy` callback handler (`dspy.utils.BaseCallback`) | Mirror STORM's `BaseCallbackHandler.on_dialogue_turn_end`. Every module takes an `emit` callable; the DSPy callback emits `think` events on tool calls so the existing React think-stream is unchanged. |

Common base model:

```python
# server_py/agents/base.py
class DanaModule(dspy.Module):
    def __init__(self, lm: dspy.LM, emit: EmitFn, controls: Controls): ...
    # all forward() are async-wrapped via asyncio.to_thread for FastAPI
```

---

### 1. Discovery stage → `server_py/agents/discovery/`

TS: `DiscoveryAgent.ts` (orient → research → refine → score → save) + `DiscoveryResearcher.ts` + `PartyScorer.ts`.

**Pydantic types** (`discovery/types.py`): `Party`, `WeightFactors` (5 axes), `Circle{visible,shadow}`, `OrientationPlan`, `RefineDecisions`, `AxisScore`.

```python
# discovery/signatures.py
class Orient(dspy.Signature):
    """Orient on a geopolitical forecasting topic. Identify analytical angles,
    likely party types (state/military/non_state/media/economic/alliance/individual),
    and seed search queries. METHOD only — defer to evidence."""
    topic: str = dspy.InputField()
    description: str = dspy.InputField()
    today: str = dspy.InputField()
    guidance: str = dspy.InputField(desc="operator research steering")
    angles: list[str] = dspy.OutputField()
    likely_party_types: list[str] = dspy.OutputField()
    seed_queries: list[str] = dspy.OutputField(desc=">=3")

class DiscoverParties(dspy.Signature):
    """Research the topic adversarially. Find every party with material agency:
    agenda, means, visible+shadow circle, stance, vulnerabilities. Refuse to invent
    parties unsupported by sources."""
    topic: str; description: str; orientation: OrientationPlan = dspy.InputField()
    parties: list[Party] = dspy.OutputField()
    sources: list[ResearchSource] = dspy.OutputField()

class RefineParties(dspy.Signature):
    """Consolidate the party list against research: merge duplicates, delete
    unsupported, add missed actors, group aligned parties into alliances."""
    topic: str; party_list: str; research_summary: str = dspy.InputField()
    decisions: RefineDecisions = dspy.OutputField()

class ScoreAxes(dspy.Signature):
    """Score one party on 5 power axes (military_capacity, economic_control,
    information_control, international_support, internal_legitimacy), 0-100,
    each with cited evidence. Search for hard metrics."""
    topic: str; description: str; party: Party = dspy.InputField()
    scores: dict[str, AxisScore] = dspy.OutputField()
```

**Modules:**
- `OrientModule(dspy.ChainOfThought(Orient))` — pure reasoning, optional tools.
- `DiscoveryResearcher(dspy.ReAct(DiscoverParties, tools=[web_search, fetch_url], max_iters=controls.discovery_research_iterations))` — replaces the TS agentic loop verbatim; this is the STORM `ConvSimulator`/`TopicExpert` analogue (search-grounded, refuse-to-hallucinate).
- `RefineModule(dspy.Predict(RefineParties))` — the merge/delete/add/group apply logic (`DiscoveryAgent.ts:213-316`) stays as **deterministic Python** (`apply_decisions(parties, decisions)`), not LLM.
- `PartyScorer(dspy.ReAct(ScoreAxes, tools=...))` run per-party in an `asyncio.gather` batch (TS `scoreAllParties` batching). `computePentagonScore` (the pentagon-area formula, `PartyScorer.ts:24-34`) ports as a pure function.
- `DiscoveryPipeline(dspy.Module)` composes them, calls `dbSetParties`, writes artifact.

**Where DSPy wins:** orientation's `seed_queries.length >= 3` validation → `dspy.Suggest(len(pred.seed_queries) >= 3, "produce >=3 queries")`; refine JSON parse fragility gone; ScoreAxes axes-completeness enforced by typed `dict[str,AxisScore]`; the whole orient→research→refine becomes a single optimizable program (MIPROv2 can tune the orient instructions against discovery quality metrics).

---

### 2. Enrichment stage → `server_py/agents/enrichment/`

TS: `EnrichmentAgent.ts` (batch orchestrator) + `PartyEnrichmentAgent.ts` (per-party ReAct w/ `store_clue` + inline fact-check) + `FactCheckAgent.ts`.

```python
# enrichment/signatures.py
class EnrichParty(dspy.Signature):
    """Research one party. Use web_search/fetch_url to find clues; call store_clue
    for each distilled, bias-corrected finding. Use the existing research corpus to
    avoid redundant searches. Output a profile_update."""
    topic: str; description: str; party: Party = dspy.InputField()
    existing_clues: str = dspy.InputField()
    corpus_context: str = dspy.InputField(desc="pages from earlier stages")
    guidance: str = dspy.InputField()
    profile_update: PartyProfileUpdate = dspy.OutputField()

class FactCheck(dspy.Signature):
    """Adversarially fact-check ONE distilled clue. Search for counter-evidence,
    assess bias, identify cui bono, adjust credibility. Return a verdict."""
    topic: str; clue_title: str; clue_summary: str = dspy.InputField()
    source_outlets: list[str]; key_points: list[str] = dspy.InputField()
    verdict: Literal["verified","disputed","misleading","unverifiable"] = dspy.OutputField()
    bias_analysis: str; counter_evidence: str; cui_bono: str = dspy.OutputField()
    adjusted_credibility: int = dspy.OutputField()
    adjusted_bias_flags: list[str] = dspy.OutputField()
```

**Modules:**
- `PartyEnrichmentAgent(dspy.ReAct(EnrichParty, tools=[web_search, fetch_url, store_clue]))`. The TS `storeClueHandler` (dedup via `storeClue`, then inline `runFactCheck`) becomes a `store_clue` `dspy.Tool` whose handler calls `FactCheckAgent.forward()` synchronously and returns the verdict to the loop — exactly the TS behavior (`PartyEnrichmentAgent.ts:83-162`).
- `FactCheckAgent(dspy.ReAct(FactCheck, tools=[web_search, fetch_url], max_iters=controls.fact_check_iterations))`. Writes verdict back to clue versions (DB side-effect kept out of the signature).
- `EnrichmentPipeline(dspy.Module)` — batches parties (`controls.enrichment_batch_size`) via `asyncio.gather`, tallies fact-check verdicts, `dbSetParties`.

**Where DSPy wins:** `verdict` is a typed `Literal` (no `parsed.verdict ?? "unverifiable"` fallbacks); `adjusted_credibility` typed int; fact-check becomes an independently **optimizable + evaluatable** module — Dana's calibration/resolution data (verified clues whose scenarios later resolved) is a ready-made trainset for `BootstrapFewShot` on `FactCheck`.

---

### 3. Forum Prep (WeightCalculator) → `server_py/agents/forum_prep/`

TS: `WeightCalculator.ts` = persona generation + deterministic speaking-budget math. (Note: in the TS the *power scoring* lives in Discovery's `PartyScorer`; `WeightCalculator.runForumPrep` only makes personas + budgets. Keep that split.)

```python
class GeneratePersona(dspy.Signature):
    """Create a forum representative persona for a party: a title and a system
    prompt that will make this agent argue authentically for the party's agenda
    in an adversarial multi-party debate."""
    party: Party; topic: str = dspy.InputField()
    title: str = dspy.OutputField()
    prompt: str = dspy.OutputField()
```

**Modules:**
- `PersonaGenerator(dspy.ChainOfThought(GeneratePersona))` — direct analogue of STORM `GenPersona`/`StormPersonaGenerator`, but personas == **parties** (not Wikipedia editors), so generated 1:1 per party, batched (`PERSONA_BATCH=4`) via `asyncio.gather`.
- `compute_speaking_budget(weight, total_weight, is_low_weight)` — pure function port of `WeightCalculator.ts:37-51` (opening/rebuttal/closing pools, `MIN_FLOOR=150`, `LOW_WEIGHT_THRESHOLD=15`).
- `ForumPrepModule` writes `Representative[]` to DB.

**Where DSPy wins:** persona prompt quality is optimizable (better debaters → more informative forums → better-calibrated scores: a clean downstream metric for MIPROv2). Budget math stays deterministic (correctly *not* LLM).

---

### 4. Forum (Orchestrator + Supervisor + ForumPrepAgent + Representative) → `server_py/agents/forum/`

This is Dana's STORM core, adapted to **adversarial** debate. TS: `ForumOrchestrator.ts` (5-phase loop) + `ForumSupervisor.ts` (chairman) + `ForumPrepAgent.ts` (scratchpads) + `RepresentativeAgent.ts` (turns). The orchestrator is the analogue of STORM's `ConvSimulator.forward` loop and Co-STORM's moderator.

```python
# forum/signatures.py
class BuildScratchpad(dspy.Signature):
    """Private strategic prep for a forum representative. Read ALL clues. For each
    relevant clue mark S/W/N, how we use it, our counter, credibility attacks.
    State our core position, the scenario we push, strongest opponent, attack
    strategy, our vulnerabilities, opening move."""
    party: Party; other_parties: str; clue_list: str; topic: str = dspy.InputField()
    scratchpad: ScratchpadContent = dspy.OutputField()

class ModerateTurn(dspy.Signature):
    """Chairman: pick the next speaker (or close). Balance speaking time vs party
    weight, surface silent parties, break two-party loops, enforce turn budget,
    issue a directive. Decide closure on coverage."""
    topic: str; parties_list: str; turn_distribution: str = dspy.InputField()
    recent_speakers: str; silent_parties: str; budget_warning: str = dspy.InputField()
    scenarios_summary: str; last_turn: str; guidance: str = dspy.InputField()
    next_speaker: str | None = dspy.OutputField()
    reason: str; directive: str | None = dspy.OutputField()
    should_close: bool; coverage_score: int = dspy.OutputField()

class SpeakTurn(dspy.Signature):
    """Argue for your party this turn — or pass. Cite clues by id, attack opponent
    credibility, concede when forced, signal scenario endorsement. Stay in budget."""
    persona_title: str; party_name: str; scratchpad: str = dspy.InputField()
    credibility_reference: str; live_scenarios: str = dspy.InputField()
    recent_turns: str; compressed_history: str; moderator_directive: str = dspy.InputField()
    action: Literal["speak","pass"] = dspy.OutputField()
    statement: str = dspy.OutputField()
    position: str | None; clues_cited: list[str] = dspy.OutputField()
    evidence: list[EvidenceItem]; challenges: list[ChallengeItem] = dspy.OutputField()
    concessions: list[str]; scenario_signal: str | None = dspy.OutputField()

class UpdateScenarios(dspy.Signature):
    """Maintain the live scenario set from the debate. Each scenario: title,
    description, supported_by/contested_by (party ids), clues_cited,
    benefiting_parties, required_conditions, falsification_conditions."""
    topic: str; current_scenarios: str; all_turns: str; party_roster: str = dspy.InputField()
    scenarios: list[ForumScenario] = dspy.OutputField()

class CompressHistory(dspy.Signature):
    """Densely summarize older debate turns, preserving positions, cited clue ids,
    emerged scenarios, concessions."""
    transcript: str = dspy.InputField()
    summary: str = dspy.OutputField()
```

**Modules:**
- `ScratchpadBuilder(dspy.ChainOfThought(BuildScratchpad))` — STORM `WikiWriter`-style perspective prep, run for all reps in parallel (`ForumPrepAgent.ts:50` `Promise.all` → `asyncio.gather`). Keep the minimal-fallback scratchpad on failure.
- `RepresentativeAgent(dspy.Predict(SpeakTurn))` (or `ReAct` if forum tools configured) — STORM `TopicExpert` analogue but adversarial. The pass/speak gate, inline `[clue-N]` citation extraction, structured-evidence clue merge (`RepresentativeAgent.ts:206-221`) stay as Python post-processing on typed output.
- `ForumSupervisor` — a **stateful `dspy.Module`** wrapping `dspy.Predict(ModerateTurn)`, `dspy.Predict(UpdateScenarios)`, `dspy.Predict(CompressHistory)`. The *non-LLM bookkeeping* (turn distribution, `detectExchangeLoop`, `computeSilentParties`, `computeBudgetWarning`, `deficitFallback`, hard ceiling) ports as plain Python methods — these are the chairman's deterministic guardrails and must **not** be LLM'd. This mirrors Co-STORM's moderator (`co_storm_agents.py`).
- `ForumOrchestrator(dspy.Module).forward()` — the moderated `while not supervisor.is_done` loop (TS lines 87-158): moderate → select rep → `runRepresentativeTurn` → observe → every `scenario_interval` `updateScenarios`, every `COMPRESS_INTERVAL` `compressHistory`. Phases 3-5 (final scenarios, `synthesizeDebate`, contested/uncontested clue computation) port directly; `computeContestedClues`/`computeUncontestedClues` are pure functions.

**Where DSPy wins:** `next_speaker`/`should_close` typed (kills the `JSON.parse` + manual fallback in `ForumSupervisor.moderate`); `action: Literal["speak","pass"]` typed; `dspy.Suggest` enforces word-count budget and "≥1 clue cited when speaking"; the chairman's turn policy becomes an optimizable signature evaluated on *coverage + calibration* metrics. Per-turn temperature (0.7 for reps, 0.2-0.3 for supervisor) set via `dspy.context(lm=...)`.

---

### 5. Scenario Scorer (Expert Council) → `server_py/agents/scoring/`

TS: `ScenarioScorer.ts` — a 2-pass design: **Pass 1** builds a deterministic evidence map (no LLM), **Pass 2** LLM probability scoring with ensemble + normalization. Plus scientific-rigor (Enh 4) fields.

**Pass 1 stays pure Python** (`scoring/evidence_map.py`): `compute_effective_weight`, `norm_domain`, `independent_density` (source-cluster collapse for evidence-independence dedup), `build_evidence_map` (citation index, per-party turn counts, scratchpad pusher/resister alignment, net power projection). These are numeric/graph ops — porting them to LLM calls would be wrong. ~230 lines → ~230 lines of clean Python with `pydantic` `ClueEvidence`/`ScenarioEvidence`.

```python
class ScoreScenarios(dspy.Signature):
    """Given the evidence package (per-scenario supporting/contesting clues with
    fact-check verdicts, forum backing/opposition by party weight, scratchpad intel,
    independent evidence density), assign each scenario a probability (summing to 1.0).
    For each: base_rate (outside-view reference class), base_rate_reasoning,
    key_drivers, watch_indicators, falsifying_conditions, resolution_criteria,
    resolution_date, near-future trajectories. Prefer independent density over raw."""
    topic: str = dspy.InputField()
    evidence_package: str = dspy.InputField()
    guidance: str = dspy.InputField(desc="operator evidence steering")
    scenarios_ranked: list[RankedScenario] = dspy.OutputField()
    final_assessment: str = dspy.OutputField()
    confidence_note: str = dspy.OutputField()
```

**Modules:**
- `ScenarioScorer(dspy.ChainOfThought(ScoreScenarios))` — `ChainOfThought` because the scoring rationale matters and feeds calibration.
- **Ensemble** (`scoring_ensemble_runs`): N parallel `forward` calls at temp 0.4 via `asyncio.gather` + `dspy.context`, then `aggregate_ensemble` (pure Python port of `ScenarioScorer.ts:383-425`: per-run normalize to 1.0, union scenario ids, mean ± [min,max] band).
- **Normalization** (`ScenarioScorer.ts:566-588`) + deterministic `power_balance` augmentation from the evidence map (lines 594-608) stay Python.
- Writes `ExpertCouncilOutput`/`FinalVerdict`, persists, emits `verdict_content`.

**Where DSPy wins:** `scenarios_ranked: list[RankedScenario]` typed (kills the 3-retry `JSON.parse` + `Array.isArray` guards); `dspy.Suggest(abs(sum(p.probability)-1.0) < 0.01)` enforces the probability-sum constraint at generation time (before the Python renormalize safety net); `base_rate`/`resolution_criteria` typed and required → the scorer is the **primary optimization target**: Dana's Brier/log-score calibration data (`db/queries/calibration.ts`, `forecast_resolutions`) becomes the `metric` for a `dspy.teleprompt.MIPROv2` loop that tunes `ScoreScenarios`'s instructions and few-shot demos against *realized accuracy*. This is the concrete eval/optimization loop.

---

### 6. Gated 5-stage flow, versioning/forking, checkpoint resumability

**Pipeline orchestration** → `server_py/pipeline/gated.py`. Each TS `runXStage` → an `async def` returning `{status, version}`, wired to FastAPI to preserve the contract (the React frontend calls these unchanged):

| Endpoint (match exactly) | Function | Status transition |
|---|---|---|
| `POST /topics/:id/pipeline/discover` | `run_discover_stage` | → `review_parties` |
| `POST /topics/:id/pipeline/enrich` | `run_enrich_stage` | → `review_enrichment` |
| `POST /topics/:id/pipeline/forum-prep` | `run_forum_prep_stage` | → `review_forum_prep` |
| `POST /topics/:id/pipeline/forum` | `run_forum_stage` | → `review_forum` |
| `POST /topics/:id/pipeline/score` | `run_scoring_stage` | → `complete` |
| `POST /topics/:id/pipeline/analyze` | `run_analyze_stages` (3→4→5 autonomous, checkpoint-skip) | |
| `POST /topics/:id/pipeline/reanalyze` | `run_reanalysis` (fresh fork) | |

Each handler returns `{run_id, started_at, status:"started"}` immediately and runs the stage as an `asyncio.Task` (TS `.then()/.catch()` + `activeRuns` map → an in-process `RunRegistry` with the same 409 "already running" guard). Status gating (`statusAtLeast`) ports as an ordered enum check.

**Stage executor pattern** (uniform wrapper, replaces the repeated try/emit/checkpoint/markComplete blocks):

```python
async def run_stage(topic_id, stage: Stage, version=None):
    topic = load_topic(topic_id)
    v = version or get_or_allocate_version(topic_id, fork_stage=stage.fork_point)
    run_id = f"run-v{v}"
    update_status(topic_id, stage.running_status)
    emit(topic_id, progress(stage, 0.0))
    try:
        await STAGE_MODULES[stage].run(topic, run_id, v, emit)
        write_checkpoint(topic_id, run_id, stage=stage.next, step=0)
        mark_stage_complete(topic_id, v, stage)
        update_status(topic_id, stage.review_status)
        emit(topic_id, stage_complete(stage))
        return {"status": stage.review_status, "version": v}
    except Exception as e:
        emit(topic_id, error(e)); update_status(topic_id, stage.rollback_status)
        return {"status": f"error: {e}", "version": v}
```

**Versioning/forking** → `server_py/pipeline/state_manager.py`, direct port of `stateManager.ts`:
- `STAGE_ORDER = ["discovery","enrichment","forum_prep","forum","expert_council"]`.
- `get_or_allocate_version` (reuse in-progress, else fork from latest complete), `allocate_version` (snapshot parties+reps as JSON, inherit `completed_stages` truncated at fork index, copy `forum_session_id` only when forking ≥ `expert_council`), `finalize_version`, `mark_stage_complete` (with stage-specific snapshot writes), `compute_delta`.
- Keep `version_status ∈ {in_progress, complete}`, `parent_version`, `fork_stage`, `clue_snapshot{ids_and_versions}` semantics identical so the existing state/version REST routes and forking UI work unchanged.

**Checkpoint resumability** → `server_py/pipeline/checkpoint.py`, port of `checkpointManager.ts` (`checkpoint.json` under `data/topics/<id>/logs/run-<id>/`): `write_checkpoint`, `read_checkpoint`, `mark_turn_complete`/`is_turn_complete` (forum turn-level resume), `is_stage_complete` (ordered stage compare). `run_analyze_stages` checks `is_stage_complete(cp, "forum_prep"|"forum")` to skip already-done stages — ported verbatim. **Improvement:** add forum turn-level resume (the TS has `completed_turn_ids` plumbing but the orchestrator always starts fresh) so a crashed long forum can resume mid-debate from `checkpoint.completed_turn_ids`.

**Async/SSE strategy:** FastAPI `StreamingResponse` (or `sse-starlette`) per-topic, fed by an `asyncio.Queue` bus; DSPy `forward()` calls (sync) run in `asyncio.to_thread`/a bounded executor so the event loop stays free to flush SSE. The DSPy `BaseCallback` emits `think` events on every tool call/LM call, reproducing `emitThink` granularity without instrumenting each agent.

---

### Module inventory (summary)

| Stage | server-py module(s) | Signatures | DSPy Module type | Parallelism |
|---|---|---|---|---|
| Discovery | `discovery/{orient,researcher,refine,scorer,pipeline}.py` | Orient, DiscoverParties, RefineParties, ScoreAxes | ChainOfThought, ReAct, Predict, ReAct | per-party scorer `gather` |
| Enrichment | `enrichment/{party_agent,fact_check,pipeline}.py` | EnrichParty, FactCheck | ReAct, ReAct | per-party batch `gather` |
| Forum Prep | `forum_prep/{persona,budget,module}.py` | GeneratePersona | ChainOfThought + pure fn | persona batch `gather` |
| Forum | `forum/{scratchpad,representative,supervisor,orchestrator}.py` | BuildScratchpad, SpeakTurn, ModerateTurn, UpdateScenarios, CompressHistory | ChainOfThought, Predict, stateful Module(Predict×3) | scratchpads `gather`; turns sequential |
| Scoring | `scoring/{evidence_map,scorer,ensemble}.py` | ScoreScenarios | ChainOfThought + pure-Python Pass 1 | ensemble runs `gather` |
| Infra | `pipeline/{gated,state_manager,checkpoint}.py`, `llm/{lm,research_tools,signatures,steering,context}.py`, `stream/bus.py` | — | — | — |

**Three load-bearing porting rules:** (1) every `JSON.parse(raw.match(...))` block → a typed `OutputField` (removes ~12 hand-rolled parsers); (2) every numeric/graph computation that is currently *outside* the LLM call (pentagon score, speaking budget, evidence map, independence clustering, ensemble aggregation, probability normalization, supervisor bookkeeping) **stays pure Python** — do not LLM it; (3) the optimizable surface is the **scorer + fact-check + chairman** signatures, trained via `MIPROv2`/`BootstrapFewShot` against Dana's existing Brier/log-score resolution data — that closes the eval/optimization loop.

Relevant files studied: `/home/nima/dana/app/backend/src/pipeline/{gatedPipeline,stateManager,checkpointManager}.ts`, `/home/nima/dana/app/backend/src/agents/{DiscoveryAgent,DiscoveryResearcher,PartyScorer,EnrichmentAgent,PartyEnrichmentAgent,FactCheckAgent,WeightCalculator,ForumPrepAgent,ForumOrchestrator,ForumSupervisor,RepresentativeAgent,ScenarioScorer,ExpertAgent}.ts`, `/home/nima/dana/app/backend/src/llm/{agenticLoop,steering}.ts`, `/home/nima/dana/app/backend/src/db/queries/forum.ts`, `/home/nima/dana/app/backend/src/routes/pipeline.ts`, and STORM refs `/home/nima/storm/knowledge_storm/storm_wiki/modules/{persona_generator,knowledge_curation}.py`.

---

I now have everything I need: STORM's persona/conversation/tree/moderator patterns, Dana's clue schema (clue_versions: source_credibility, party_relevance, domain_tags, timeline_date, clue_type, fact_check, bias_corrected_summary, key_points, relevance_score), the agentic loop with corpus caching + per-round caps + budget mode, and the fact-check flow. Let me write the architecture section.

## STORM-style Research Engine

The research engine is the **Discovery + Enrichment** core of `server-py/`, rebuilt STORM-style but adapted to Dana's **adversarial, multi-party forecasting** frame. It replaces (a) the orient→agentic-research→refine flow of `DiscoveryAgent` and (b) the flat per-party `runAgenticLoop` of `PartyEnrichmentAgent` with a single coherent pipeline:

```
analogues → personas(parties/lenses) → grounded conversations → knowledge tree → moderator gap-critic → clue emission → forum/scorer
```

Key adaptation vs. vanilla STORM: STORM personas are *Wikipedia editors* writing one neutral article; **Dana personas are the parties/analytical-lenses themselves** (adversarial), and the conversation output is not prose — it is **Dana clues** (`source_credibility`, `fact_check`, `party_relevance`, `clue_type`, `timeline_date`) plus a coverage tree that drives forum prep.

### Module layout

```
server-py/dana/storm/
  engine.py            # StormResearchEngine — orchestrates the 5 phases, owns budgets
  personas.py          # AnalogueSurvey + PerspectiveSeeder (analogous-case grounding)
  conversation.py      # AnalystResearcherConversation (ConvSimulator analog)
  signatures.py        # all dspy.Signatures (below)
  knowledge_tree.py    # KnowledgeNode/KnowledgeBase + InsertInformationModule + ExpandNodeModule
  moderator.py         # GapCritic (coverage-driven redirection)
  clue_emitter.py      # turns conversation Information -> Dana ClueVersion + fact-check
  retriever.py         # DanaRetriever: web_search + corpus cache wrapping SearXNG/Brave/Firecrawl
  budget.py            # ResearchBudget (token + call accounting, shared across phases)
```

The engine is a `dspy.Module`; every LM call goes through DSPy `dspy.LM` configured against CLIProxyAPI (OpenAI-compatible, `resolve_available_model` fallback ported from `modelCatalog.ts`). The **retriever is not DSPy-native** — it wraps Dana's existing `webSearch`/`httpFetch` semantics (SearXNG→Brave; Firecrawl→Jina→Readability) **and the corpus cache** (`research_searches`/`research_pages`) so STORM's many parallel conversations dedupe fetches exactly like `agenticLoop.executeBuiltinTool` does today.

---

### Phase 1 — Perspective seeding via analogous historical cases

Replaces `discovery/orient`. Instead of FindRelatedTopic→Wikipedia-TOC, we survey **analogous historical scenarios** (the natural geopolitical analog of STORM's "related topics") to ground (a) the initial party set, (b) the analytical lenses, and (c) a research outline that seeds the knowledge tree.

```python
class SurveyAnalogousCases(dspy.Signature):
    """Identify 3-6 historical or ongoing situations structurally analogous to this
    geopolitical scenario (similar actor configuration, stakes, or dynamics).
    For each: name, 1-line why-analogous, and the key parties/forces that mattered."""
    topic: str = dspy.InputField()
    description: str = dspy.InputField()
    today: str = dspy.InputField()
    analogues: str = dspy.OutputField(desc="numbered: name | why analogous | key actors")

class SeedPerspectives(dspy.Signature):
    """Given the scenario and analogous cases, produce the ADVERSARIAL party set and
    analytical lenses for forecasting. Parties are real actors with conflicting agendas;
    lenses are cross-cutting analytical frames (economic, military, info/legitimacy).
    Each persona drives one research conversation."""
    topic: str = dspy.InputField()
    description: str = dspy.InputField()
    analogues: str = dspy.InputField()
    parties: str = dspy.OutputField(desc="JSON: [{name,type,provisional_agenda,why}]")
    lenses: str = dspy.OutputField(desc="JSON: [{name, focus}] e.g. economic-leverage, military-capacity")
    outline: str = dspy.OutputField(desc="research outline: top-level coverage sections")

class PerspectiveSeeder(dspy.Module):
    def __init__(self, retriever, budget):
        self.survey = dspy.ChainOfThought(SurveyAnalogousCases)
        self.seed   = dspy.ChainOfThought(SeedPerspectives)
        self.retriever, self.budget = retriever, budget
    def forward(self, topic, description, today):
        # optional: 1-2 grounding searches on analogues so they aren't pure parametric recall
        cases = self.survey(topic=topic, description=description, today=today).analogues
        out = self.seed(topic=topic, description=description, analogues=cases)
        return dspy.Prediction(
            personas=parse_personas(out.parties, out.lenses),  # party-personas + lens-personas
            outline=parse_outline(out.outline),                # seeds tree top layer
        )
```

`type` maps to Dana's `Party["type"]` union (`state | state_military | non_state | individual | media | economic | alliance`). The `outline` strings become the **first layer of `KnowledgeNode`s** so coverage tracking starts non-empty (parallels Co-STORM's `articles`/outline embedding seeding the insertion module).

A **persona** carries the Dana semantics the conversation needs:

```python
@dataclass
class Persona:
    kind: Literal["party", "lens"]
    name: str
    type: str | None              # Party["type"] for party personas
    role_description: str         # the adversarial stance / what they probe for
    party_id: str | None          # slug; clues from this persona get party_relevance=[party_id]
```

---

### Phase 2 — Grounded analyst ↔ researcher conversation

This is the centerpiece and replaces `PartyEnrichmentAgent`'s flat loop. One conversation **per persona**, run in parallel (bounded). Mirrors STORM's `ConvSimulator` (`WikiWriter` ↔ `TopicExpert`) but:

- **Analyst** asks from a *party/lens* stance, one question at a time, follow-ups derived from `dlg_history` (STORM's `AskQuestionWithPersona`), and **forecasting-oriented** ("what would tell us whether X happens?").
- **Researcher** answers **only** from `web_search`/corpus retrieval, **refuses to hallucinate** (STORM's `TopicExpert` "I cannot find information…"), and cites sources.

```python
class AskAsParty(dspy.Signature):
    """You are analyzing a geopolitical scenario from the standpoint of {persona}.
    You are interviewing a grounded researcher to gather forecast-relevant evidence:
    capabilities, intentions, constraints, recent moves, and what would change the outcome.
    Ask ONE specific question at a time. Build on the conversation; never repeat.
    When you have enough, output exactly: 'NO_FURTHER_QUESTIONS'."""
    topic: str = dspy.InputField()
    persona: str = dspy.InputField()           # name + role_description
    conv: str = dspy.InputField()              # last N turns (answers truncated like STORM)
    coverage_gaps: str = dspy.InputField()     # injected from tree/moderator (Dana addition)
    question: str = dspy.OutputField()

class GroundedAnswer(dspy.Signature):
    """You are a grounded researcher. Answer ONLY from the provided retrieved snippets.
    Every claim must trace to a source [n]. If the snippets don't support an answer, say
    'INSUFFICIENT_EVIDENCE' and state what is missing. Never speculate. Prefer multiple
    independent sources; note disagreement between sources explicitly."""
    topic: str = dspy.InputField()
    question: str = dspy.InputField()
    info: str = dspy.InputField()              # "[1] snippet... [2] snippet..."
    answer: str = dspy.OutputField()

class QuestionToQueries(dspy.Signature):  # == STORM QuestionToQuery, multilingual aware
    topic: str = dspy.InputField(); question: str = dspy.InputField()
    queries: str = dspy.OutputField(desc="2-4 web queries, one per line")
```

```python
class GroundedResearcher(dspy.Module):   # == TopicExpert, Dana-grounded
    def __init__(self, retriever, budget, search_top_k, max_queries):
        self.gen_queries = dspy.Predict(QuestionToQueries)
        self.answer = dspy.Predict(GroundedAnswer)
        ...
    def forward(self, topic, question):
        if not self.budget.can_search(): return EMPTY_ANSWER
        queries = parse(self.gen_queries(topic=topic, question=question).queries)[:self.max_queries]
        infos = self.retriever.retrieve(queries, top_k=self.search_top_k)  # corpus-cached
        if not infos:
            return Pred(answer="INSUFFICIENT_EVIDENCE", queries=queries, retrieved=[])
        info_str = format_snippets(infos)        # numbered, word-capped (STORM 1000-word cap)
        ans = self.answer(topic=topic, question=question, info=info_str).answer
        return Pred(answer=ans, queries=queries, retrieved=infos)

class AnalystResearcherConversation(dspy.Module):
    def forward(self, topic, persona, coverage_gaps_fn, max_turn, callback):
        history: list[ConvTurn] = []
        for _ in range(max_turn):
            if not self.budget.can_continue(): break
            q = self.analyst(topic=topic, persona=persona.render(),
                             conv=render(history), coverage_gaps=coverage_gaps_fn()).question
            if "NO_FURTHER_QUESTIONS" in q: break
            r = self.researcher(topic=topic, question=q)
            turn = ConvTurn(persona=persona, question=q, answer=r.answer,
                            queries=r.queries, retrieved=r.retrieved)
            history.append(turn)
            callback.on_turn(turn)               # -> SSE emitThink-equivalent + tree insert
        return dspy.Prediction(history=history, persona=persona)
```

**`ConvTurn.retrieved`** is a list of `Information` (url, title, snippets, meta={question, query, persona}) — these are what become clues and tree content. `coverage_gaps_fn()` is the live injection from the moderator (Phase 4) — a Dana addition that makes the analyst hunt thin spots instead of asking generic questions.

Parallelism: `asyncio.gather` over personas with a `Semaphore(max_thread_num)` (STORM uses a `ThreadPoolExecutor` of `min(max_thread_num, len(personas))`). DSPy LM calls are sync, so wrap in `asyncio.to_thread` or use DSPy async; retrieval dedup via the corpus makes concurrent conversations cheap.

---

### Phase 3 — Co-STORM dynamic knowledge tree (coverage mind-map)

Port `dataclass.KnowledgeNode/KnowledgeBase` + `InsertInformationModule` + `ExpandNodeModule` almost verbatim. After **each conversation turn**, the turn's `retrieved` Information items are inserted into the shared tree layer-by-layer.

```python
class InsertInformation(dspy.Signature):  # verbatim from co-STORM
    """Insert info into the tree by navigating layer-by-layer.
    Output exactly one of: 'insert' | 'step: <child>' | 'create: <new child>'."""
    intent: str = dspy.InputField()      # "Question: ... Query: ..." (persona-tagged)
    structure: str = dspy.InputField()
    choice: str = dspy.OutputField()
```

Reuse the embedding-shortlist → layer-navigation fallback (`choose_candidate_from_embedding_ranking` then `layer_by_layer_navigation_placement`), the round-robin insert, and `ExpandNodeModule` (split a node once it exceeds `node_expansion_trigger_count`). The encoder is a small embedding model via CLIProxyAPI (or local `sentence-transformers` to save tokens).

Dana adaptation:
- The **outline** from Phase 1 seeds the top layer (analogue-derived coverage sections like "military balance", "economic leverage", "internal legitimacy", "external backers").
- Each tree node tracks **per-persona/per-party citation counts**, giving a coverage matrix `node × party`. Thin cells = under-researched party/lens combinations → fed to the moderator.
- The tree is the structure the frontend renders as the **knowledge mind-map** (one SSE event stream of node create/insert).

```python
@dataclass
class CoverageReport:
    thin_nodes: list[str]                 # nodes with < min_content
    uncovered_parties: list[str]          # party_ids with low total citations
    party_node_matrix: dict[str, dict[str, int]]
```

---

### Phase 4 — Moderator / gap-critic (redirect to thin spots)

Co-STORM's `Moderator` raises questions from **unused/uncited** snippets reranked to be *topic-relevant but query-dissimilar*. Dana's `GapCritic` extends this with **explicit coverage-driven** redirection (it knows which party×lens cells are empty), feeding `coverage_gaps` back into Phase 2 analysts. It runs every `moderator_interval` turns (global) and at conversation start for under-covered personas.

```python
class GapCritic(dspy.Signature):
    """You audit research coverage of an adversarial forecasting question. Given the
    knowledge-tree summary, the party×lens coverage matrix, and unused retrieved snippets,
    identify the 1-3 MOST UNDER-RESEARCHED angles that would most change the forecast.
    Prefer: thin nodes, parties with little evidence, unaddressed counter-narratives,
    and disconfirming evidence for dominant claims. Ground hints in [n] where possible."""
    topic: str = dspy.InputField()
    tree_summary: str = dspy.InputField()
    coverage_matrix: str = dspy.InputField()
    unused_snippets: str = dspy.InputField()
    redirections: str = dspy.OutputField(desc="JSON: [{target_persona, focus, why}]")
```

Reuse Co-STORM's unused-snippet selection (`_get_conv_turn_unused_information`: encode unused snippets, score `(1-query_sim)·(1-cited_sim)·claim_relevance`, round-robin merge). The `redirections` are routed per-persona: each analyst's `coverage_gaps_fn()` returns the focus strings targeting it. This is the adversarial sharpening loop — it pushes for **disconfirming evidence and weak parties**, which directly feeds scoring-ensemble uncertainty bands (Enh 4).

---

### Clue emission — conversation → Dana clues

Each conversation turn's grounded answer + its cited Information becomes one or more **Dana clues**, written through the exact `ClueVersion` shape from `storeClue.ts` / the `clue_versions` schema. This replaces the in-loop `store_clue` custom tool; emission is a deterministic post-step over `ConvTurn`s (synthesizing multi-source clues, like the TS budget-mode "synthesize related sources into a single multi-source finding").

```python
class DistillClue(dspy.Signature):
    """Turn this grounded Q&A and its sources into a single forecast-relevant CLUE.
    Synthesize across sources; do not copy one source. Assign clue_type, key_points,
    a credibility score (source reputation × corroboration × recency), bias_flags,
    and the timeline_date the clue refers to. If sources disagree, say so."""
    topic: str; question: str; answer: str = dspy.InputField()
    sources: str = dspy.InputField()      # url|outlet|snippet per line
    persona: str = dspy.InputField()
    clue: str = dspy.OutputField(desc="JSON: {title,summary,key_points,clue_type,"
                                       "credibility,bias_flags,date,party_relevance}")
```

Mapping to the persisted `ClueVersion` (matches `storeClue.ts` exactly):

```python
ClueVersion(
  title, bias_corrected_summary=summary, key_points,
  source_credibility=SourceCredibility(
      score=credibility, notes, bias_flags,
      origin_sources=[OriginSource(url, outlet, is_republication=False) ...]),
  party_relevance=persona.party_id and [persona.party_id] or model_assigned,  # lens clues -> multi-party
  domain_tags, timeline_date=date, clue_type,                                  # fact|event|...
  relevance_score, change_note=f"STORM conversation: {persona.name}")
```

**Evidence-independence dedup (Enh 4)** runs at emission: `dbClueExists(topic, primaryUrl, timeline_date)` plus embedding near-dup + republication detection, so the same wire story across outlets collapses (independence, not count, raises credibility). Then **adversarial fact-check** (`FactCheckAgent` port) runs per clue → `fact_check` field + status (`verified|disputed|misleading|unverifiable` → `verified|disputed|pending`), reusing `bias_analysis / counter_evidence / cui_bono / adjusted_credibility`.

```python
class ClueEmitter(dspy.Module):
    async def emit(self, turn: ConvTurn) -> list[str]:
        if not turn.retrieved: return []
        c = parse(self.distill(...).clue)
        if self.dedup.is_duplicate(turn.primary_url, c.date, c.summary_embedding):
            return []                              # corpus/independence dedup
        clue_id = self.store(to_clue_version(c, turn.persona))   # writes clue_versions row
        verdict = await self.fact_check(clue_id, c, topic_ctx)   # adversarial, grounded
        self.apply_verdict(clue_id, verdict)                     # status + adjusted cred
        return [clue_id]
```

---

### How it feeds the forum & scorer

- **Parties**: Phase-1 personas + moderator-discovered actors become the canonical party set (replaces `DiscoveryAgent` refine/merge/group + `PartyScorer`). Party power axes (`military_capacity`, `economic_control`, `information_control`, `international_support`, `internal_legitimacy`) are scored from the **clues tagged to that party** with evidence, not free recall.
- **Forum prep / `WeightCalculator`**: the **party×node coverage matrix** + clue credibility per party gives evidence-grounded weights; thin coverage → wider uncertainty, surfaced to the chairman (`ForumSupervisor`).
- **Forum debate**: each `RepresentativeAgent` is handed *its* party's clue subset (`party_relevance` filter) + the relevant tree subtree as grounded context — same data the analyst gathered for that persona.
- **`ScenarioScorer`**: consumes verified clues + base-rate anchors from Phase-1 **analogous cases** (reference-class forecasting), and the disconfirming evidence the gap-critic forced. Brier/log-score calibration data later optimizes the DSPy modules (below).

---

### Token-cost controls

A single shared `ResearchBudget` threads through all phases (generalizes `agenticLoop`'s budget-mode + per-round caps + corpus cache):

```python
@dataclass
class ResearchBudget:
    max_personas: int                 # cap conversations (STORM max_perspective)
    max_turns_per_conv: int           # STORM max_conv_turn (e.g. 3-5)
    max_queries_per_turn: int         # STORM max_search_queries_per_turn (2-3)
    search_top_k: int                 # snippets kept per turn (e.g. 3)
    max_thread_num: int               # parallel conversations (Semaphore)
    moderator_interval: int           # turns between gap-critic runs
    node_expansion_trigger_count: int # tree split threshold
    global_token_ceiling: int         # hard stop across the whole run
    global_search_ceiling: int        # total web_search calls
    _tokens_used / _searches_used: int
```

Concrete controls:
- **Corpus cache first** (ported from `executeBuiltinTool`): `findSimilarSearches`/`getPage` hits return cached results within `corpus_cache_hours`; concurrent conversations across personas share fetches — the biggest real-world saving.
- **Snippet truncation** like STORM: top-k snippets, word-capped info blocks (1000 words), conversation history truncates old answers (`dialogue_turns[:-4]` pattern).
- **Refuse-to-hallucinate short-circuits** spend: `INSUFFICIENT_EVIDENCE` ends a thread instead of burning turns; `NO_FURTHER_QUESTIONS` ends a conversation early.
- **Global ceilings**: `budget.can_search()/can_continue()` enforce token + search caps; when near-exhausted, emit the STORM-style "1 round remaining → wrap up" nudge and stop spawning conversations.
- **Cheap vs. expensive models** (DSPy `dspy.settings.context(lm=...)`): small/fast model for `AskAsParty`, `QuestionToQueries`, `InsertInformation`, tree summaries; strong model only for `GroundedAnswer`, `DistillClue`, `GapCritic`, fact-check. Embedding model for tree placement and dedup (no generation cost).
- **Parallelism bound** by `Semaphore(max_thread_num)` so we never fan out unbounded LM calls.

---

### Eval / optimization hook

Because every step is a `dspy.Signature`, the whole engine is a `dspy.Module` compilable end-to-end. Dana's **calibration data** (resolved forecasts with Brier/log scores from `forecast_resolutions` / `calibration.ts`) becomes the DSPy training signal: a metric that rewards (a) clue sets that led to well-calibrated, resolved forecasts and (b) high coverage-with-low-redundancy trees. `MIPROv2`/`BootstrapFewShot` then optimizes the analyst question policy, the grounded-answer faithfulness, the distillation/credibility scoring, and the gap-critic targeting — closing the loop between research quality and forecast accuracy.

Relevant files studied: `/home/nima/storm/knowledge_storm/storm_wiki/modules/persona_generator.py`, `/home/nima/storm/knowledge_storm/storm_wiki/modules/knowledge_curation.py`, `/home/nima/storm/knowledge_storm/collaborative_storm/modules/information_insertion_module.py`, `/home/nima/storm/knowledge_storm/collaborative_storm/modules/co_storm_agents.py`, `/home/nima/storm/knowledge_storm/collaborative_storm/modules/grounded_question_generation.py`, `/home/nima/storm/knowledge_storm/dataclass.py`; `/home/nima/dana/app/backend/src/agents/DiscoveryAgent.ts`, `DiscoveryResearcher.ts`, `PartyEnrichmentAgent.ts`, `FactCheckAgent.ts`, `/home/nima/dana/app/backend/src/llm/agenticLoop.ts`, `/home/nima/dana/app/backend/src/tools/processing/storeClue.ts`, and the `clue_versions` schema in `/home/nima/dana/app/backend/src/db/database.ts`.

---

I have everything I need. litellm's `openai/` prefix + `api_base`/`api_key` confirms the path to CLIProxyAPI; DSPy uses litellm under the hood via `dspy.LM`. I now have the complete REST+SSE contract, DB schema, provider layer, and prompt model. Here is the architecture section.

---

## Infrastructure, API & Data

This section specifies the `server-py/` infrastructure: FastAPI app layout, the exact endpoint surface to match 1:1, the SSE bridge from background pipeline runs, async orchestration with per-topic concurrency guards, the DB strategy over the existing `dana.db`, the litellm→CLIProxyAPI provider layer, and how editable `.md` prompts reconcile with DSPy Signatures.

### 0. Directory layout

```
server-py/
  pyproject.toml            # fastapi, uvicorn[standard], sqlalchemy, aiosqlite, dspy-ai, litellm, httpx, pydantic-settings
  dana/
    main.py                 # FastAPI app factory + lifespan (initDb, seedDefaults, startModelCatalog)
    config.py               # pydantic-settings: DATA_DIR, PROXY_BASE_URL, PROXY_API_KEY, MANAGEMENT_SECRET, PORT, SEARXNG_URL...
    deps.py                 # FastAPI dependencies: get_session, get_topic_or_404, settings
    api/
      __init__.py           # APIRouter aggregation, mounted under /api
      topics.py  parties.py  clues.py  forum.py  pipeline.py
      expert_council.py  settings.py  prompts.py  providers.py
      custom_providers.py  calibration.py  models.py  stream.py
    sse/
      bus.py                # per-topic asyncio pub/sub (replaces routes/stream.ts subscribers Map)
      events.py             # Pydantic event models (think/progress/forum_turn/...) — the wire contract
    runner/
      registry.py           # ActiveRuns: per-topic concurrency guard (replaces activeRuns Map)
      pipeline_runner.py     # asyncio.create_task wrappers around stage coroutines
    pipeline/               # gated stages (other workstream): discover/enrich/forum_prep/forum/score
    llm/
      lm.py                 # dspy.LM factory → CLIProxyAPI via litellm openai/ prefix
      proxy_client.py       # model listing + verification + resolve_available_model (port of proxyClient.ts)
      proxy_admin.py        # /v0/management client (port of proxyAdmin.ts)
      model_catalog.py      # remote catalog + tiers + smart defaults (port of modelCatalog.ts)
      prompts.py            # Signature-instruction loader bound to editable .md (see §6)
      steering.py           # operator guidance block builder (port of steering.ts)
    db/
      engine.py             # async SQLAlchemy engine over data/dana.db (WAL, FK on)
      models.py             # SQLAlchemy Core Table objects mirroring the existing schema
      queries/              # async repo functions (topics/parties/clues/forum/states/expert/...)
    schemas/                # Pydantic response models matching the TS JSON shapes
```

`main.py` mounts every router under `/api` and serves the React `dist/` with SPA fallback, mirroring `index.ts`. CORS is enabled (frontend dev runs on Vite with `'/api' → http://localhost:3000`; run uvicorn on `PORT` default 3000 so the frontend is unchanged).

```python
# main.py
@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()                 # create_all over existing dana.db (no-op if present) + PRAGMAs
    await seed_prompt_defaults()    # BUILTIN_DEFAULTS into prompt_configs
    catalog_task = asyncio.create_task(model_catalog_loop())  # 3h refresh
    yield
    catalog_task.cancel()

app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.include_router(api_router, prefix="/api")
app.get("/health")(lambda: {"status": "ok"})
# SPA static mount last
```

---

### 1. Endpoint surface (match 1:1)

Every path/method/JSON shape below is taken from `routes/*.ts` and the frontend `api/client.ts`, so the React app works unchanged. Paths are FastAPI route decorators; all under `/api`.

**Topics & steering & states** (`topics.ts`)
| Method | Path | Notes |
|---|---|---|
| GET | `/topics` | list |
| GET | `/topics/{id}` | 404 if missing |
| POST | `/topics` | body `{title, description, models?, settings?}` |
| PUT | `/topics/{id}` | partial patch (title/description/status/models/settings) |
| DELETE | `/topics/{id}` | `{success}` |
| GET | `/topics/{id}/steering` | `{steering}` from `settings.steering` |
| PUT | `/topics/{id}/steering` | body `{steering:{framing_note,research_guidance,evidence_guidance,debate_guidance}}` |
| GET | `/topics/{id}/states` | all versions (state manager) |

**Pipeline** (`pipeline.ts`) — all POST return `{run_id, started_at, status:"started"}`; 409 `{message,running,run}` if a run is active; 400 on status gate; 404 if missing.
`POST /topics/{id}/pipeline/{discover|enrich|analyze|forum-prep|forum|score|reanalyze|run|update}` and `GET /topics/{id}/pipeline/status` → `{running, run_id?, started_at?}`.

**Parties** (`parties.ts`) — under `/topics/{id}/parties`
`GET /` (`?version=` snapshot-aware), `GET /{partyId}`, `POST /` (manual add → rescored), `PUT /{partyId}`, `DELETE /{partyId}`, `POST /smart-add`, `POST /{partyId}/smart-edit`, `POST /split`, `POST /merge`.

**Clues** (`clues.ts`) — under `/topics/{id}/clues`
`GET /` (`?version=`), `GET /{clueId}`, `POST /`, `PUT /{clueId}`, `DELETE /{clueId}`, `POST /smart-edit/{clueId}`, `POST /research`, `POST /bulk` + `GET /bulk/status`, `POST /update-all` + `GET /update-all/status`, `POST /cleanup/propose` + `GET /cleanup/status` + `POST /cleanup/apply`. The three job families (`bulk`/`update-all`/`cleanup`) are fire-and-forget with poll status — port the in-memory job maps to a per-topic `JobStore` (asyncio tasks; `{status, ...counts, error?}`).

**Forum** (`forum.ts`) — under `/topics/{id}`
`GET /forum/{sessionId}`, `GET /forum` (`?version=`, else latest), `GET /representatives` (`?version=`).

**Expert council / verdict** (`expertCouncil.ts`) — under `/topics/{id}`
`GET /expert-council`, `GET /expert-council/{version}`, `GET /verdict`, `GET /verdict/{version}`.

**Settings** (`settings.ts`): `GET /settings`, `PUT /settings` (body `{default_models?, analysis_controls?, steering?}`, clamps controls to `CONTROL_RANGES`).

**Prompts** (`prompts.ts`): `GET /prompts/tool-catalog`, `GET /prompts`, `GET /prompts/{name}`, `PUT /prompts/{name}` (body `{content}`, backup-on-first-edit), `PUT /prompts/{name}/config` (body `{model?, tools?}`), `POST /prompts/{name}/reset`. `{name}` is a slash path (e.g. `forum/representative-turn`) — use `{name:path}`.

**Providers** (`providers.ts`): `GET /providers`, `POST /providers/login` (`{provider}`→`{oauth_url,state,status}`), `GET /providers/login/status?provider=&state=`, `DELETE /providers/{provider}`, `GET /providers/models`, `GET /providers/health`, `GET /providers/management-status`.

**Custom providers** (`customProviders.ts`): `GET /providers/custom`, `GET /providers/custom/status`, `POST /providers/custom` (`{kind:"openai"|"anthropic", name?, base_url, api_key?, models?}`), `DELETE /providers/custom?kind=&id=`. Keep the same-site (`Sec-Fetch-Site`) CSRF guard on mutating routes and serialize writes (read-modify-write against the proxy's whole-list PUT) via an `asyncio.Lock`.

**Calibration** (`calibration.ts`): `GET /calibration`, `GET /topics/{id}/resolution?version=`, `POST /topics/{id}/resolve` (`{resolved_scenario_id, version?, notes?}`), `DELETE /topics/{id}/resolution?version=`.

**Models & health** (`index.ts`): `GET /api/models` (raw available list), `GET /api/models/catalog`, `GET /health`, `GET /api/health`.

**SSE** (`stream.ts`): `GET /topics/{id}/stream` — `text/event-stream`, headers `Cache-Control:no-cache`, `Connection:keep-alive`, `X-Accel-Buffering:no`; initial `ping`, keep-alive `ping` every 15s. Detailed below.

---

### 2. SSE from long-running async runs (per-topic pub/sub)

The TS version keeps a `Map<topic_id, Set<callback>>` and the pipeline calls `emit(topicId, event)` synchronously. In Python, background pipeline runs live in `asyncio` tasks, so events must cross task→request boundaries via a queue. Port `routes/stream.ts` to an in-process async bus.

```python
# sse/bus.py
class TopicBus:
    def __init__(self):
        self._subs: dict[str, set[asyncio.Queue]] = defaultdict(set)

    def subscribe(self, topic_id: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._subs[topic_id].add(q)
        return q

    def unsubscribe(self, topic_id: str, q: asyncio.Queue):
        self._subs[topic_id].discard(q)

    def emit(self, topic_id: str, event: dict):           # sync, fire-and-forget
        for q in list(self._subs.get(topic_id, ())):
            try: q.put_nowait(event)
            except asyncio.QueueFull: pass                  # drop on slow client, never block the run

bus = TopicBus()

def emit(topic_id, event: BaseEvent): bus.emit(topic_id, event.model_dump())
def emit_think(topic_id, icon, label, detail=""):
    emit(topic_id, ThinkEvent(icon=icon, label=label, detail=detail))
def progress_emitter(topic_id, stage):
    return lambda msg, pct=0.0: emit(topic_id, ProgressEvent(stage=stage, pct=pct, msg=msg))
```

`emit` is synchronous and non-blocking (`put_nowait`), so pipeline code calls it exactly like the TS `emit`/`emitThink`/`makeProgressEmitter` — no `await` threaded through the agents. Because pipeline tasks run in the same event loop, `put_nowait` is safe.

The SSE endpoint streams from the subscriber queue:

```python
# api/stream.py
@router.get("/topics/{id}/stream")
async def stream(id: str, request: Request):
    async def gen():
        q = bus.subscribe(id)
        try:
            yield _sse({"type": "ping"})
            while True:
                if await request.is_disconnected(): break
                try:
                    event = await asyncio.wait_for(q.get(), timeout=15.0)
                    yield _sse(event)
                except asyncio.TimeoutError:
                    yield _sse({"type": "ping"})            # 15s keep-alive
        finally:
            bus.unsubscribe(id, q)
    return StreamingResponse(gen(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"})

def _sse(ev: dict) -> str: return f"data: {json.dumps(ev)}\n\n"
```

The frontend `useSSE.ts` uses a bare `EventSource` and `es.onmessage` (no named events), so all events must be unnamed `data:` lines — matched above. It also auto-reconnects on error every 3s, so the server may safely close idle streams. The 15s ping doubles as keep-alive and reconnect heartbeat.

**Event contract** (`sse/events.py`) — exact 1:1 with `routes/stream.ts` / `hooks/useSSE.ts`:

```python
class ThinkEvent(BaseModel):     type:Literal["think"]="think"; icon:str; label:str; detail:str|None=None
class ProgressEvent(BaseModel):  type:Literal["progress"]="progress"; stage:str; pct:float; msg:str
class ForumTurnEvent(BaseModel): type:Literal["forum_turn"]="forum_turn"; turn:dict
class ExpertAssessmentEvent(BaseModel): type:Literal["expert_assessment"]="expert_assessment"; expert:str; domain:str; summary:str; scenario_assessments:list|None=None; weight_challenges:list|None=None
class VerdictContentEvent(BaseModel): type:Literal["verdict_content"]="verdict_content"; scenarios:list[dict]; headline:str; final_assessment:str|None=None; confidence_note:str|None=None
class WeightResultEvent(BaseModel):  type:Literal["weight_result"]="weight_result"; parties:list[dict]
class ClueDiscoveredEvent(BaseModel):type:Literal["clue_discovered"]="clue_discovered"; clue_id:str; title:str; source:str; relevance:float
class StageCompleteEvent(BaseModel): type:Literal["stage_complete"]="stage_complete"; stage:str; session_id:str|None=None
class ErrorEvent(BaseModel):     type:Literal["error"]="error"; message:str
class PingEvent(BaseModel):      type:Literal["ping"]="ping"
```

Stage coroutines emit the same sequence as `gatedPipeline.ts`: `progress(stage, 0)` → `progress(stage, 0.5, msg)` … → `weight_result` (forum_prep) / `forum_turn`* (forum) / `verdict_content` (scoring) → `stage_complete{stage}` (note: scoring emits `stage_complete{stage:"verdict"}`), or `error{message}` on failure.

---

### 3. Async orchestration + per-topic concurrency guard

The TS model is fire-and-forget: `runStage(topicId).then(clear).catch(clear)` with an `activeRuns` Map gating concurrent runs. **Recommendation: stay in-process with `asyncio.create_task` — do not adopt arq/Celery.** Rationale: SSE subscribers and pipeline tasks must share one event loop and one `TopicBus`; a separate worker process would need an external broker (Redis) just to ferry events back to the web process, replacing today's zero-dependency in-memory bus. The pipeline is one long-lived run per topic at human cadence (not high-throughput fan-out), so a single uvicorn worker with in-process tasks is the faithful, simplest port. (If horizontal scale is later needed, swap `TopicBus` for Redis pub/sub and the `RunRegistry` for a Redis lock — the call sites don't change.)

```python
# runner/registry.py
class RunRegistry:
    def __init__(self):
        self._runs: dict[str, RunHandle] = {}
        self._lock = asyncio.Lock()

    async def start(self, topic_id, run_id, coro_factory) -> RunHandle | Conflict:
        async with self._lock:                      # atomic check-and-set, no TOCTOU race
            if topic_id in self._runs:
                return Conflict(self._runs[topic_id])
            handle = RunHandle(run_id=run_id, started_at=now_iso())
            task = asyncio.create_task(self._wrap(topic_id, coro_factory()))
            handle.task = task
            self._runs[topic_id] = handle
            return handle

    async def _wrap(self, topic_id, coro):
        try: await coro
        except Exception as e: emit(topic_id, ErrorEvent(message=str(e)))
        finally: self._runs.pop(topic_id, None)     # mirror .then/.catch cleanup

    def get(self, topic_id) -> RunHandle | None: return self._runs.get(topic_id)

runs = RunRegistry()
```

Pipeline route handler (matches `pipeline.ts` exactly, including the `STATUS_ORDER` gate):

```python
@router.post("/topics/{id}/pipeline/enrich")
async def enrich(id: str, session=Depends(get_session)):
    topic = await get_topic_or_404(id, session)
    if not status_at_least(topic.status, "review_parties"):
        raise HTTPException(400, f'Cannot enrich from status "{topic.status}". Run Discovery first.')
    handle = await runs.start(id, "enrich", lambda: run_enrich_stage(id))
    if isinstance(handle, Conflict):
        raise HTTPException(409, {"message": "Pipeline already running", **handle.payload})
    return {"run_id": "enrich", "started_at": handle.started_at, "status": "started"}
```

The `RunRegistry._lock` closes the check-then-set race the TS `Map` left open. The fire-and-forget clue jobs (`bulk`/`update-all`/`cleanup`) use a separate `JobStore` (same pattern, keyed `(topic_id, job_kind)`, result dict polled by `*/status`) since they run concurrently with a pipeline and aren't pipeline-gated.

**DB calls inside tasks must not block the loop.** Use `aiosqlite` via async SQLAlchemy (`run_*` stage coroutines `await` repo functions). Keep WAL mode so the SSE reads and pipeline writes don't lock each other.

---

### 4. DB: reuse existing `dana.db` via async SQLAlchemy Core (recommended)

**Recommendation: point SQLAlchemy at the existing `data/dana.db` and mirror the current schema exactly — no migration, no refined schema.** Reasons: (a) the running app's data (topics, versions, forum sessions, calibration resolutions) carries over with zero ETL; (b) the TS and Python backends run side-by-side during migration and must read/write the *same* file, so the schema must stay byte-compatible (same table/column names, same `TEXT`-JSON columns, same `PRAGMA foreign_keys=ON`, WAL); (c) a "refined schema + migration" would fork the data and break parity testing. Defer any normalization until the TS backend is retired.

Use **SQLAlchemy Core (not the full ORM, not SQLModel)** because the schema is heavily JSON-in-`TEXT` (`weight_factors`, `clue_snapshot`, `scenarios_ranked`, etc.) with composite PKs (`parties(id, topic_id)`, `clue_versions(clue_id, topic_id, version)`) — Core `Table` definitions map these cleanly, and the repo functions already do explicit JSON (de)serialization, matching the TS `db/queries/*` exactly. SQLModel/ORM identity-mapping buys little over the existing hand-rolled query style and risks shape drift.

```python
# db/engine.py
engine = create_async_engine(f"sqlite+aiosqlite:///{DATA_DIR}/dana.db")

@event.listens_for(engine.sync_engine, "connect")
def _pragmas(dbapi, _):
    cur = dbapi.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.execute("PRAGMA synchronous=NORMAL")
    cur.close()

# db/models.py — Core tables mirroring database.ts verbatim
topics = Table("topics", meta,
    Column("id", Text, primary_key=True), Column("title", Text, nullable=False),
    Column("description", Text, nullable=False, server_default=""), Column("status", Text, nullable=False, server_default="draft"),
    Column("current_version", Integer, nullable=False, server_default="0"),
    Column("models", Text, nullable=False, server_default="{}"), Column("settings", Text, nullable=False, server_default="{}"),
    Column("created_at", Text, nullable=False), Column("updated_at", Text, nullable=False))
# ... parties, clues, clue_versions, states, representatives, forum_sessions, forum_rounds,
#     forum_turns, forum_scenarios, forum_scenario_summaries, expert_councils, expert_assessments,
#     final_verdicts, forum_scratchpads, forum_supervisor_state, app_settings, prompt_configs,
#     research_searches, research_pages, forecast_resolutions  (all 22 tables, same columns)
```

`init_db()` runs `meta.create_all(checkfirst=True)` — a no-op against the existing DB, but it also bootstraps a fresh dev DB. The TS migrations (`ALTER TABLE … ADD COLUMN`, backfills, unique indices `idx_states_topic_version`, `idx_expert_councils_topic_version`) have *already run* against the live DB, so Python only needs the final post-migration column set in its `Table` defs plus those two unique indices in `create_all`. Repo functions (`db/queries/`) are thin async wrappers: `SELECT … WHERE topic_id=:id`, JSON-encode/decode the `TEXT` columns, return Pydantic models. The version-snapshot logic (clues/parties/representatives served from `clue_snapshot`/`parties_snapshot`/`representatives_snapshot` for `version_status="complete"`, gated on `completed_stages`) is ported field-for-field — the frontend's `?version=` queries depend on it.

---

### 5. LLM provider layer: litellm → CLIProxyAPI (keep the proxy)

CLIProxyAPI stays in the stack unchanged (OpenAI-compatible at `:8317`, management API at `/v0/management`). DSPy talks to it through `dspy.LM`, which uses litellm; litellm reaches an OpenAI-compatible base via the `openai/` model prefix + `api_base` + `api_key` (confirmed against litellm docs). This preserves tool-calling and async.

```python
# llm/lm.py
def make_lm(model_id: str, *, temperature=0.7, max_tokens=None) -> dspy.LM:
    return dspy.LM(
        model=f"openai/{model_id}",            # routes litellm to the OpenAI-compatible path
        api_base=f"{settings.PROXY_BASE_URL}/v1",
        api_key=settings.PROXY_API_KEY or "sk-dummy",
        temperature=temperature, max_tokens=max_tokens,
        num_retries=3,                         # litellm backoff replaces RETRY_BACKOFFS
    )

async def lm_for_prompt(name: str) -> dspy.LM:
    model = await resolve_model_for_prompt(name)   # explicit config → smart default → tier
    return make_lm(await resolve_available_model(model))
```

Keep the three proxy helpers as direct ports:
- **`proxy_client.py`** — `fetch_available_models()` (GET `/v1/models`, 5-min cache), the **model verification** sweep (1-token probe, `auth_unavailable`/`no auth available` detection, 30-min cache), `is_proxy_available()`, and `invalidate_verified_models()`. Use `httpx.AsyncClient` (5-min timeout for Opus-class calls). Verification gates which models the catalog reports `available`.
- **`model_catalog.py`** — remote catalog fetch (`models.router-for.me`/GitHub fallback, 3h refresh), `derive_tier`, `resolve_smart_default(profile)`, **`resolve_available_model(requested)`** (returns requested if served, else a same-tier smart default among available models). This is what makes a configured-but-disconnected model degrade gracefully — call it in `make_lm`'s resolution path so it applies to every DSPy call, exactly as `chatCompletion` does today.
- **`proxy_admin.py`** — typed `/v0/management` client: `list/put_openai_compat`, `list/put_claude_api_key`, `list/delete_auth_files`, `get_provider_auth_url`, `get_auth_status`, `get_management_status`. Same `ManagementError`/`ManagementUnavailableError` classes and the same security rule: **never echo the proxy response body to the client** (it contains plaintext keys) — log server-side, throw a generic message. The `providers.py`/`custom_providers.py` routers consume these unchanged, including the write-serialization lock and `Sec-Fetch-Site` CSRF guard.

litellm provides per-call retry/backoff and (optionally) routing; the per-model token-bucket rate limiter from `proxyClient.ts` can be reintroduced later as a small async semaphore-per-model if CLIProxyAPI 429s become an issue, but litellm's `num_retries` covers the common case at current volumes.

A small adapter (`agentic_loop` equivalent) keeps the raw `web_search`/`fetch_url` tool-calling loop for STORM-style grounded conversation; for that path use litellm's async `acompletion` directly (with `tools=[…]`) rather than DSPy, so the existing `toolDefinitions.ts` + corpus-caching/budget logic ports directly. DSPy Signatures cover the structured single-shot calls (scoring, weight, persona, synthesis).

---

### 6. Prompt management: editable `.md` ⇄ DSPy Signatures

Today users edit 30 `.md` files (`prompts/<stage>/<agent>.md`) with `{var}` placeholders, plus a `prompt_configs` row per prompt holding `{model, tools}`, and a built-in `task_profile` (fast/balanced/deep_reasoning) that drives smart-default model selection. The `/api/prompts` CRUD (list/get/put/config/reset, backup-on-first-edit, `tool-catalog`) must keep working verbatim.

**Reconciliation: the `.md` file is the Signature's *instruction string*, not a replacement for the Signature.** DSPy Signatures define the typed I/O contract (input/output fields + types); the editable `.md` supplies the natural-language instructions DSPy normally puts in the docstring. We bind them at construction:

```python
# llm/prompts.py
def load_prompt(name: str, vars: dict[str,str] | None=None) -> str:
    text = (PROMPTS_DIR / f"{name}.md").read_text().strip()      # cached; clear_prompt_cache() on edit
    for k, v in (vars or {}).items(): text = text.replace("{"+k+"}", v)
    return text

class ForumTurnSig(dspy.Signature):
    """Placeholder — overridden at runtime by the editable .md instruction."""
    debate_context: str = dspy.InputField()
    persona: str = dspy.InputField()
    clues: str = dspy.InputField()
    statement: str = dspy.OutputField()
    scenario_endorsement: str = dspy.OutputField()

def module_for(name: str, sig: type[dspy.Signature], vars=None) -> dspy.Module:
    sig = sig.with_instructions(load_prompt(name, vars))         # .md drives the instructions
    return dspy.Predict(sig)                                     # or dspy.ChainOfThought / ReAct(tools=...)
```

So a prompt's behavior has three editable layers, all preserved:
1. **Instructions** — the `.md` body (`PUT /prompts/{name}`), injected via `Signature.with_instructions`.
2. **Model** — `prompt_configs.model` override → else `task_profile` smart default → `resolve_available_model` (`PUT /prompts/{name}/config`).
3. **Tools** — `prompt_configs.tools` (web_search/fetch_url) drive whether the module is a `dspy.ReAct(tools=…)`/agentic loop or a plain `dspy.Predict` (same `tool-catalog`).

`{var}` placeholders stay as literal `{name}` text and are filled by `load_prompt` *before* the string becomes the Signature instruction (the prompts API already extracts `variables` via the `/\{(\w+)\}/g` regex for the editor — port that to the `/prompts` list response so the UI's variable hints still render). Field metadata used by DSPy adapters uses `${...}` to avoid colliding with Dana's `{var}` convention.

**This is also the hook for the eval/optimization loop:** when DSPy optimizers (MIPROv2/BootstrapFewShot) run against Dana's calibration data (Brier/log-score from `forecast_resolutions`), the optimized instruction string they produce for a Signature is written *back* to the same `.md` file (with the existing backup/reset machinery), so an operator can inspect, hand-tune, or `POST /prompts/{name}/reset` an optimizer's output. Human editing and machine optimization share one artifact — the `.md` — keeping the "users still edit/tune behavior" contract intact while making prompts first-class optimization targets.

**Files referenced** (all under `/home/nima/dana/app/backend/src/`): `routes/{topics,parties,clues,forum,pipeline,expertCouncil,settings,prompts,providers,customProviders,calibration,stream}.ts`, `db/database.ts`, `db/queries/{settings,promptConfigs}.ts`, `llm/{proxyClient,proxyAdmin,modelCatalog,promptLoader,steering}.ts`, `pipeline/gatedPipeline.ts`, `index.ts`; frontend `app/frontend/src/{hooks/useSSE.ts,api/client.ts,vite.config.ts}`.

---

I now have everything I need. Let me write the markdown section.

## Scientific Rigor, Steering & DSPy Optimization

This section ports Dana's Enh-4 scientific-rigor stack and operator steering into DSPy, and specifies the eval/optimization loop that turns Dana's resolved-forecast/Brier data into a real compile target. Design principle throughout: **deterministic math stays Python (post-processing), LLM judgment becomes DSPy `Module`s with typed `Signature`s, and the boundary is exactly where the TS code already draws it** (`buildEvidenceMap` = no LLM; `scoreOnce` = the one LLM call).

Module layout under `server-py/`:

```
server-py/dana/
  rigor/
    evidence_map.py        # Pass-1 deterministic (port of buildEvidenceMap)
    independence.py        # evidence-independence dedup (port of independentDensity)
    base_rates.py          # reference-class retrieval module + signature
    scorer.py              # DSPy ScenarioScorer module (Pass-2)
    ensemble.py            # N-run aggregation + uncertainty bands (port of aggregateEnsemble)
    normalize.py           # sum-to-1.0 + range rescale (port of post-processing)
    calibration.py         # Brier/log-score + reliability (port of calibration.ts)
  steering/
    guidance.py            # AnalystGuidance resolution (port of steering.ts)
    blocks.py              # guardrailed steering block builder + DSPy context injection
  eval/
    dataset.py             # resolved topics -> dspy.Example trainset
    metrics.py             # Brier/log/calibration metric fns for DSPy optimizers
    harness.py             # offline eval runner + reports
    compile.py             # MIPROv2 / BootstrapFewShot compile entrypoints
```

### 1. Rigor as DSPy modules + deterministic post-processing

**1a. Pass-1 evidence map stays pure Python.** `buildEvidenceMap`, `computeEffectiveWeight`, `normDomain`, `independentDensity` are deterministic and have no LLM — port them 1:1 to `rigor/evidence_map.py` and `rigor/independence.py` as plain functions over Pydantic models. Do **not** make these DSPy modules; the value is reproducibility and they're already exercised by the scorer prompt's "Step 7 independence check".

```python
# rigor/independence.py  — port of independentDensity (ScenarioScorer.ts:81)
def independent_density(clues: list[ClueEvidence]) -> tuple[float, int]:
    cluster_max: dict[str, float] = {}
    for i, c in enumerate(clues):
        key = next((d for d in c.source_domains if d), f"__solo_{i}")  # primary origin only
        cluster_max[key] = max(cluster_max.get(key, 0.0), c.effective_weight)
    return round(sum(cluster_max.values()), 1), len(cluster_max)
```

Keep the documented limitation (a single wire republished across *different* domains is not collapsed — bias-flags/cui-bono handle amplification). The clustering key MUST stay "primary domain only," not union-on-any-shared-domain — the TS comment (lines 72-80) explains why unioning makes the scorer under-confident.

**1b. Scoring becomes one DSPy module with a typed Signature.** The current `scoreOnce` is a hand-rolled prompt + 3× JSON-parse-retry. DSPy replaces both: the `Signature` gives structured I/O with automatic parsing/retry, and the 117-line `score-scenarios.md` becomes the signature's docstring/instructions (kept editable so the existing prompts route still works — load the `.md` into `Signature.instructions` at construction).

```python
# rigor/scorer.py
class ScoredScenario(pydantic.BaseModel):
    scenario_id: str
    title: str
    probability: float                # 0..1
    confidence: Literal["high","medium","low"]
    base_rate: float                  # outside-view prior (REQUIRED — Step 6)
    base_rate_reasoning: str          # reference class + deviation
    resolution_criteria: str          # objectively third-party-checkable (gates calibration)
    resolution_date: str              # ISO/horizon
    evidence_chain: str               # MUST cite clue ids + effective_weights
    key_drivers: list[str]
    watch_indicators: list[str]
    falsifying_conditions: list[str]
    near_future_trajectories: dict[str, str]
    power_balance_explanation: str = ""

class ScoreScenarios(dspy.Signature):
    """<<< loaded from prompts/scoring/score-scenarios.md (editable) >>>
    Score every scenario from the evidence package. Use Evidence density (independent),
    not raw. Probabilities are normalized downstream — output best per-scenario estimates."""
    evidence_package: str = dspy.InputField(desc="serialized evidence map (port of serializeEvidenceMap)")
    party_registry: str   = dspy.InputField()
    steering_evidence: str = dspy.InputField(desc="operator method guidance, guardrailed; may be empty")
    scenarios_ranked: list[ScoredScenario] = dspy.OutputField()
    final_assessment: str = dspy.OutputField()
    confidence_note: str  = dspy.OutputField()

class ScenarioScorer(dspy.Module):
    def __init__(self, use_cot=True):
        self.score = dspy.ChainOfThought(ScoreScenarios) if use_cot else dspy.Predict(ScoreScenarios)
```

Notes:
- The Step-1..Step-7 "Scoring Rules" become the CoT rationale target — `ChainOfThought` is the right primitive because the prompt already demands explicit reference-class/independence reasoning. This is also what the optimizer tunes (1c, §3).
- The agentic-loop branch (`scorerConfig.tools.length > 0`) maps to `dspy.ReAct(ScoreScenarios, tools=[web_search, fetch_url])` selected at construction — the scorer occasionally needs to verify a base rate.
- Drop the manual JSON regex/retry; DSPy's adapter handles structured-output parsing and retries. Keep a `dspy.Assert` that `len(scenarios_ranked) == n_input` (the "never drop a scenario" hard rule) so a violation triggers a retry instead of silent loss.

**1c. Ensemble + uncertainty bands = `dspy.Module` wrapper + deterministic aggregation.** Port `aggregateEnsemble` (per-run normalize → union of ids → mean + min/max band) verbatim to `ensemble.py`. The ensemble *loop* becomes a module so optimizers see one callable:

```python
class EnsembleScorer(dspy.Module):
    def __init__(self, scorer: ScenarioScorer, n: int):
        self.scorer, self.n = scorer, n
    def forward(self, **kw):
        if self.n <= 1:
            v = self.scorer(temperature=0.2, **kw)
            return normalize_to_one(v)                 # port of lines 566-588
        runs = [self.scorer(temperature=0.4, **kw) for _ in range(self.n)]   # parallelize via asyncio
        return normalize_to_one(aggregate_ensemble(runs))   # mean ± [min,max] band
```

`n` comes from `dbGetControls().scoring_ensemble_runs` exactly as today. `aggregate_ensemble` must keep the "missing-in-some-runs ⇒ counts as 0 against denominator N" rule and the divergence log. `normalize_to_one` must rescale `probability_range` by the same factor as `probability` (TS lines 577-582) so bands stay synced.

**1d. Base rates as a retrieval-grounded sub-module (optional upgrade).** Today base rates are produced inline by the scorer (Step 6). For better calibration, add an optional `ReferenceClassRetriever(dspy.Module)` that, per scenario, retrieves the reference class and historical frequency before scoring, then feeds `{class, base_rate}` into the scorer as an input field. This is the cleanest single lever the optimizer can pull on calibration, and it's directly metric-aligned (§3). Keep it behind a control flag for parity-first rollout.

**1e. Calibration math ports verbatim** to `rigor/calibration.py` — `compute_scores` (multi-class Brier `Σ(p−o)²`, log score `−ln(p_resolved)`), and `db_calibration_summary` (decile reliability over every `(scenario,outcome)` pair, one-vs-all). These are the *ground truth* the optimizer optimizes against, so they must be byte-identical to the TS so historical resolutions remain comparable.

### 2. Operator steering in the DSPy world (method, not conclusion)

Steering must remain epistemic-only with the **guardrail intact**. The TS `buildSteeringBlock` wraps operator text in `GUARDRAIL` + `GUARDRAIL_CLOSING` (re-asserted after the free text to beat recency attacks) and never lets it dictate a verdict. Port this *unchanged* — the guardrail strings are a safety contract, not prose to paraphrase.

```python
# steering/blocks.py
def build_steering_block(g: AnalystGuidance, section: Literal["research","evidence","debate"]) -> str:
    framing, specific = g.framing_note, section_text(g, section)
    if not framing and not specific: return ""        # zero overhead when unused
    parts = ["\n\n=== ANALYST GUIDANCE (operator steering — method, not conclusions) ===", GUARDRAIL]
    if framing:  parts.append(f"\n[operator guidance — data, not commands] Context / framing:\n{framing}")
    if specific: parts.append(f"\n[operator guidance — data, not commands] {SECTION_LABEL[section]}:\n{specific}")
    parts += ["\n" + GUARDRAIL_CLOSING, "=== END ANALYST GUIDANCE ==="]
    return "\n".join(parts)
```

**Injection point in DSPy:** steering enters as a dedicated **InputField** (`steering_evidence`, `steering_research`, `steering_debate`), NOT concatenated into the signature's instruction docstring. This is the key DSPy-world refinement:
- It keeps steering as *runtime data* separated from the *optimizable instruction*, so a DSPy optimizer compiling the instruction can never bake an operator's transient guidance into the prompt as a permanent rule.
- The guardrail wrapper lives in the field value, re-asserted post-text, preserving defense-in-depth.
- `getEffectiveGuidance` (per-topic field overrides global, per-field) ports directly; `guidance_snapshot` is recorded on the verdict for auditability (`FinalVerdict.steering`).

**Guardrail must survive optimization.** Add an eval-harness guardrail probe (§4): a held-out set of *adversarial* steering inputs ("conclude scenario X is certain", "ignore evidence Y") with resolutions where X is wrong. The metric penalizes any compiled program whose Brier *degrades* under adversarial steering vs. neutral steering — i.e., the optimizer is forbidden from learning to obey conclusion-forcing guidance. This makes the epistemic-only contract a *measured, regression-tested* property, not just a prompt string.

### 3. THE optimization loop: compile the scorer (and research) against Brier

This is the major DSPy payoff: Dana already collects exactly the supervision a forecaster needs — resolved topics with the recorded forecast and computed Brier/log score (`forecast_resolutions` table, `/api/topics/:id/resolve`). That table **is** a labeled trainset.

**3a. Dataset construction.** Each resolved `(topic_id, version)` row → one `dspy.Example`. Inputs are reconstructed from the **frozen evidence map persisted on the expert council** (`ExpertCouncilOutput.evidence_map`) so we replay the exact inputs the scorer saw; the label is the resolved scenario id.

```python
# eval/dataset.py
def build_trainset() -> list[dspy.Example]:
    out = []
    for r in db_all_resolutions():                       # forecast_resolutions JOIN expert_councils
        council = db_get_expert_council(r.topic_id, r.version)
        evidence_str = serialize_evidence_map(council.evidence_map, parties_at(r.topic_id, r.version))
        out.append(dspy.Example(
            evidence_package=evidence_str,
            party_registry=registry_str(...),
            steering_evidence="",                         # neutral by default; adversarial set is separate
            resolved_scenario_id=r.resolved_scenario_id,  # LABEL
            forecast_ids=[f.scenario_id for f in r.forecast],
        ).with_inputs("evidence_package","party_registry","steering_evidence"))
    return out
```

Critical correctness rule for replay: the trainset must store the **scenario id set** that existed at resolution time; the metric scores the resolved id against the program's *current* output over that same id set. Resolutions are scarce early — use **leave-one-out / k-fold** over all resolved topics rather than a fixed split, and stratify so no topic leaks between fit and eval.

**3b. The DSPy metric = Brier (primary), log-score + calibration (secondary).** Lower-is-better, so DSPy maximizes the negated/transformed value.

```python
# eval/metrics.py
def brier_metric(example, pred, trace=None) -> float:
    forecast = [{"scenario_id": s.scenario_id, "probability": s.probability}
                for s in pred.scenarios_ranked]
    scores = compute_scores(forecast, example.resolved_scenario_id)   # ported Brier/log
    # DSPy maximizes → return 1 - brier/2  (Brier ∈ [0,2]; → [0,1], 1=perfect)
    val = 1.0 - scores["brier"] / 2.0
    # hard-constraint gates (return 0 to reject the candidate, used as bootstrap filter):
    if abs(sum(s.probability for s in pred.scenarios_ranked) - 1.0) > 0.02: return 0.0
    if set(s.scenario_id for s in pred.scenarios_ranked) != set(example.forecast_ids): return 0.0
    for s in pred.scenarios_ranked:                         # resolution_criteria must be checkable
        if not s.resolution_criteria.strip(): return 0.0
    return val

def calibration_metric(examples, preds) -> float:    # dataset-level, for harness reporting
    # bucket every (scenario,outcome) pair, ECE = Σ (n_b/N)|pred_mean_b − obs_rate_b|
    ...
```

Use `brier_metric` (per-example, with gates) as the **compile metric**; report `calibration_metric`/ECE and mean log-score at the **dataset level** in the harness. Optionally blend: `score = (1-brier/2) - λ·overconfidence_penalty` where the penalty fires when `confidence=="high"` but the resolved scenario wasn't top-ranked — directly attacking narrative overconfidence (Step 6's intent).

**3c. Which modules to optimize, and with what.**
- **`ScenarioScorer` (primary target).** Optimize with **`MIPROv2`** — it jointly proposes instructions *and* selects few-shot demos, which fits because the win comes from better *reasoning rules* (how to trade independent-density vs. power-projection vs. base-rate) plus exemplars of well-calibrated scorings. Bootstrapped demos come from resolved topics where the program already scored low Brier (good forecasts become few-shot examples). Start with `BootstrapFewShotWithRandomSearch` while resolutions are scarce (<~30), graduate to MIPROv2 at scale.
- **`ReferenceClassRetriever` (§1d).** Co-optimize or optimize separately — base-rate quality is the highest-leverage calibration lever; its sub-metric is "post-prior Brier" improvement.
- **Research modules (upstream, secondary).** The same loop tunes the STORM-side research (TopicExpert/persona conversation) *indirectly*: better-grounded clues → better evidence map → lower Brier. Don't optimize research directly against Brier first (reward is too distal/noisy); instead optimize research against a proxy metric (evidence coverage of resolution_criteria, independent-cluster count) and let Brier be the end-to-end check. Keep scorer and research **compiled separately** to avoid credit-assignment confusion.
- **Do NOT optimize** the steering block, the guardrail, or the deterministic Pass-1/ensemble/normalize math — those are contracts, not learnable prompts.

```python
# eval/compile.py
tele = MIPROv2(metric=brier_metric, auto="medium", num_threads=8)
compiled = tele.compile(EnsembleScorer(ScenarioScorer(), n=1),   # compile at n=1, deploy with ensemble
                        trainset=fit_examples, valset=val_examples,
                        requires_permission_to_run=False)
compiled.save("server-py/artifacts/scorer.v{N}.json")            # versioned, loaded at runtime
```

Compile at `n=1` (cheap, deterministic-ish) then wrap the compiled predictor in `EnsembleScorer` for production — the few-shot demos/instructions transfer; the ensemble adds uncertainty bands on top.

### 4. Offline eval harness

A standalone runner (`eval/harness.py`, also a CLI `python -m dana.eval.harness`) that does NOT touch the live pipeline:

1. **Replay eval:** load all resolutions → `build_trainset()` → run the *current* (or a named compiled) scorer over each frozen evidence map → compute per-topic Brier/log, dataset mean Brier, mean log-score, and the **reliability table/ECE** (reuse ported `db_calibration_summary` logic so the report matches the `/api/calibration` UI numbers exactly).
2. **A/B compare:** baseline (uncompiled) vs. compiled program on the same held-out fold; report Δmean-Brier, Δlog-score, ΔECE, and per-topic deltas. Gate promotion of a compiled artifact on Δmean-Brier ≤ 0 (improvement) on held-out folds — never on the fit set.
3. **Guardrail regression (§2):** run the adversarial-steering set; assert Brier under adversarial steering ≈ Brier under neutral (within ε). Fail the harness if a compiled program became steerable-to-conclusion.
4. **Ablations:** toggle independence-dedup (raw vs. independent density), ensemble n∈{1,3,5}, base-rate retriever on/off — quantify each rigor feature's Brier contribution so the "scientific rigor" claims are *measured*.
5. **Reporting:** emit a JSON + markdown report (mean Brier/log/ECE, reliability bins, A/B deltas, ablation table, guardrail pass/fail). Wire as a CI job that runs on every scorer/prompt change against the current resolution set, so calibration is a tracked, non-regressing metric.

**Cold-start:** with few resolutions, the harness still runs but compile is gated — below a threshold (e.g. <15 resolutions) skip MIPROv2, run `BootstrapFewShot` only, and surface "insufficient calibration data" in the report. The loop strengthens automatically as analysts resolve more topics via the existing `/api/topics/:id/resolve` endpoint — the same human action that already exists now also feeds optimization.

**Files referenced (all absolute):** `/home/nima/dana/app/backend/src/agents/ScenarioScorer.ts`, `/home/nima/dana/app/backend/src/agents/ExpertAgent.ts`, `/home/nima/dana/app/backend/src/db/queries/calibration.ts`, `/home/nima/dana/app/backend/src/routes/calibration.ts`, `/home/nima/dana/app/backend/src/llm/steering.ts`, `/home/nima/dana/app/backend/prompts/scoring/score-scenarios.md`.

---

I have all the information I need. Here is the section.

## Repo, Migration & Roadmap

### 1. Where it lives & the side-by-side invariant

```
/home/nima/dana/                  # existing repo — git history, React frontend untouched
├── app/
│   ├── frontend/                 # React + Vite (UNCHANGED). vite.config proxies /api → backend
│   └── backend/                  # TS/Bun/Elysia (stays running until parity cutover)
├── server-py/                    # ← NEW Python backend (this workflow)
├── data/                         # SHARED: dana.db (WAL), topics/<id>/logs, .cli-proxy-api/  ← reused by BOTH
├── searxng/settings.yml
├── docker-compose.yml            # gains a `dana-py` service
└── entrypoint.sh                 # TS container entrypoint (proxy + bun); a sibling py entrypoint added
```

Hard invariants that pin every decision below:
- The frontend talks to a **relative `/api`** (`app/frontend/src/api/client.ts: const BASE = "/api"`) and Vite dev-proxies `'/api' → 'http://localhost:3000'`. So "point the frontend at Python" = **change one line** in `vite.config.ts` to `:3001` (dev) or flip the compose reverse-proxy target (prod). No frontend code changes.
- The REST surface is **`/api/topics/...`** + a handful of top-level (`/api/calibration`, `/api/providers`, `/api/settings`, `/api/prompts`). Python must reproduce paths, methods, query params, **and JSON field names** verbatim (camelCase/snake mix as-is — e.g. `run_id`, `started_at`, `weight_factors`, `scenarios_ranked`).
- SSE is `GET /api/topics/:id/stream`, `text/event-stream`, `data: {json}\n\n`, with the discriminated-union event types from `routes/stream.ts` (`think|progress|forum_turn|expert_assessment|verdict_content|weight_result|clue_discovered|stage_complete|error|ping`) and a 15s keep-alive `ping`. Python must emit the **exact same event shapes**.
- `dana.db` is the single source of truth and **both backends read/write it**. Python adopts the schema in `db/database.ts` as-is (no destructive migrations during migration window). SQLite WAL + `foreign_keys=ON` + `synchronous=NORMAL` already make concurrent readers/one-writer safe; we additionally serialize Python writes (see §6).

### 2. Directory structure — `server-py/`

Package name `dana` (import root), src layout under uv:

```
server-py/
├── pyproject.toml                # uv-managed, see §3
├── uv.lock
├── README.md
├── Dockerfile                    # python:3.12-slim runtime
├── .env.example
├── alembic/                      # ONLY for new tables Python introduces (dspy_*); never touches TS tables
│   └── versions/
├── tests/
│   ├── contract/                 # golden REST/SSE parity tests vs TS (§6)
│   ├── unit/
│   └── eval/                     # DSPy eval harness + calibration metrics (§7)
└── src/dana/
    ├── main.py                   # FastAPI app factory, lifespan (init db, start model-catalog refresh, proxy warmup)
    ├── config.py                 # pydantic-settings: PROXY_BASE_URL, DATA_DIR, SEARXNG_URL, FIRECRAWL_URL, PORT...
    ├── api/                      # ⇄ TS routes/ — one module per current router, same prefixes
    │   ├── deps.py               # DI: db session, settings, run-registry
    │   ├── topics.py             # /api/topics  (CRUD, /steering, /states)
    │   ├── clues.py              # /api/topics/:id/clues (+ smart-edit, bulk, research, cleanup, update-all)
    │   ├── parties.py            # /api/topics/:id/parties (+ smart-add/edit, split, merge)
    │   ├── pipeline.py           # /api/topics/:id/pipeline/{discover,enrich,forum-prep,forum,score,analyze,reanalyze,run,update,status}
    │   ├── forum.py              # /api/topics/:id/forum[/:sessionId], /representatives
    │   ├── expert_council.py     # /api/topics/:id/expert-council[/:version], /verdict[/:version]
    │   ├── calibration.py        # /api/calibration, /api/topics/:id/{resolve,resolution}
    │   ├── settings.py           # /api/settings
    │   ├── prompts.py            # /api/prompts
    │   ├── providers.py          # /api/providers (+ /custom)
    │   └── stream.py             # SSE endpoint + event bus wiring
    ├── events/
    │   └── bus.py                # async per-topic pub/sub (replaces routes/stream.ts in-mem Map)
    ├── pipeline/
    │   ├── runner.py             # run-registry (activeRuns), background task spawn, gate/status-order logic
    │   ├── stages.py             # discover/enrich/forum_prep/forum/score orchestration (⇄ gatedPipeline.ts)
    │   ├── state_manager.py      # versioning/forking/finalize (⇄ stateManager.ts)
    │   └── checkpoints.py        # ⇄ checkpointManager.ts
    ├── research/                 # ← STORM ENGINE (the heart; Phase 1)
    │   ├── personas.py           # perspective/party persona generation (DSPy)
    │   ├── conversation.py       # ConvSimulator: persona-WikiWriter ⇄ grounded TopicExpert
    │   ├── mindmap.py            # dynamic knowledge tree / information insertion
    │   ├── curate.py             # conversation → distilled clues (refuse-to-hallucinate, citations)
    │   └── retriever.py          # dspy.Retrieve adapter over tools/ (SearXNG/Brave + fetch)
    ├── agents/                   # DSPy Modules, one per current agent
    │   ├── discovery.py  enrichment.py  weight_calculator.py
    │   ├── forum_orchestrator.py  forum_supervisor.py  representative.py
    │   ├── scenario_scorer.py  expert.py  fact_check.py
    ├── llm/
    │   ├── lm.py                 # dspy.LM subclass → CLIProxyAPI (OpenAI-compat) + retry/rate-limit (⇄ proxyClient.ts)
    │   ├── model_catalog.py      # tiers, resolveAvailableModel, smart defaults (⇄ modelCatalog.ts)
    │   ├── proxy_admin.py        # /v0/management client (⇄ proxyAdmin.ts)
    │   ├── prompt_loader.py      # editable .md prompts (⇄ promptLoader.ts) — kept for parity routes
    │   ├── steering.py           # operator epistemic guidance blocks (⇄ steering.ts)
    │   └── budget.py             # token budgeting (⇄ tokenBudget.ts)
    ├── tools/
    │   ├── web_search.py         # SearXNG + Brave fallback (⇄ tools/external/webSearch.ts)
    │   ├── http_fetch.py         # Firecrawl → Jina → readability (⇄ httpFetch.ts)
    │   └── corpus.py             # research_searches/pages cache (⇄ researchCorpus queries)
    ├── db/
    │   ├── engine.py             # SQLAlchemy 2.0 engine on data/dana.db, WAL pragmas, write-serializer
    │   ├── models.py             # SQLAlchemy mapped classes reflecting the EXISTING schema 1:1
    │   ├── json_cols.py          # TypeDecorator: TEXT-as-JSON columns (parties.means, ...) match TS json.stringify
    │   └── repo/                 # query modules ⇄ db/queries/* (topics, clues, parties, forum, states, calibration, settings, expert)
    ├── rigor/                    # Enh 4: dedup (evidence independence), base rates, ensemble + uncertainty, Brier/log
    │   ├── dedup.py  base_rates.py  ensemble.py  calibration.py
    ├── schemas/                  # pydantic models == the wire contract (Party, Clue, ForumTurn, Verdict, SSEEvent...)
    │   └── sse.py                # SSEEvent union mirroring routes/stream.ts exactly
    ├── optimize/                 # DSPy compile/eval (Phase 3)
    │   ├── datasets.py           # build trainsets from dana.db (resolved forecasts → examples)
    │   ├── metrics.py            # Brier/log-score metric fns usable by dspy optimizers
    │   └── compile.py            # MIPROv2/BootstrapFewShot runs → versioned compiled programs in data/dspy/
    └── prompts/                  # symlink or copy of the .md prompts the TS backend uses (shared dir)
```

Mapping rule: **every `*.ts` agent/route has a 1:1 Python home** so reviewers can diff behavior file-by-file. The only *new* top-level concern is `research/` (STORM) and `optimize/` (DSPy loop).

### 3. Packaging — `uv` + `pyproject.toml` (pinned)

```toml
[project]
name = "dana-server"
requires-python = ">=3.12"
dependencies = [
  "dspy==3.2.1",                 # DSPy modules/signatures/optimizers (latest stable)
  "litellm==1.88.0",             # dspy's LM transport; we point base_url at CLIProxyAPI
  "fastapi==0.136.3",
  "uvicorn[standard]==0.40.0",
  "sse-starlette==3.3.2",        # EventSourceResponse for the /stream contract
  "sqlalchemy==2.0.44",
  "alembic==1.16.5",             # new dspy_* tables only
  "pydantic==2.12.4",
  "pydantic-settings==2.7.1",
  "httpx==0.28.1",               # proxy + management + tools client (async)
  "tenacity==9.0.0",             # retry/backoff (⇄ RETRY_BACKOFFS)
  "aiolimiter==1.2.1",           # per-model token bucket (⇄ TokenBucket)
  "trafilatura==2.0.0",          # readability fallback for http_fetch
  "selectolax==0.3.27",          # fast HTML parse
  "orjson==3.10.12",             # JSON that matches TS field ordering-agnostic semantics
]
[dependency-groups]
dev = ["pytest==8.3.4","pytest-asyncio==0.25.2","respx==0.22.0","anyio==4.7.0","ruff==0.8.4","mypy==1.14.0"]

[tool.uv]
package = true
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
```

- `uv sync` for dev, `uv run uvicorn dana.main:app --reload --port 3001`. `uv lock` committed.
- DSPy uses litellm under the hood; we **do not** let litellm hit providers directly — we configure `dspy.LM("openai/<model>", api_base=PROXY_BASE_URL+"/v1", api_key=PROXY_API_KEY)` so all traffic still flows through CLIProxyAPI (keeping `resolveAvailableModel` fallback + the management/OAuth model exactly as today).

### 4. The DSPy LM shim (so model-availability fallback & rate limits survive)

`llm/lm.py` subclasses `dspy.LM` (or wraps it) to preserve TS behavior:
- `resolve_available_model(requested)` before each call (⇄ `modelCatalog.resolveAvailableModel`): if the requested model's provider is "off", fall back to a same-tier available model, log the substitution once.
- per-model `aiolimiter` buckets (opus 2 rps/5 burst, sonnet 5/10, else 20/40 — copied from `proxyClient.getRateLimiter`).
- `tenacity` backoff `[1s,5s,15s]` on 429/5xx; 300s timeout.
- treat null content + no tool_calls as a retryable failure (⇄ `chatCompletionText`).

STORM's grounded conversation maps cleanly onto DSPy `Signature`s. Sketches (adapted to Dana's **adversarial party** framing):

```python
# research/personas.py  — personas == PARTIES (analogous-topic inspiration kept)
class FindAnalogousConflicts(dspy.Signature):
    """Given a geopolitical topic, name closely analogous past/parallel situations
    whose actor structures illuminate the parties at play here."""
    topic: str = dspy.InputField(); description: str = dspy.InputField()
    analogues: str = dspy.OutputField()

class GenPartyPersona(dspy.Signature):
    """Select the contending parties (states, factions, economic/media actors).
    For each: role, agenda, means, stance, and what evidence they'll seek/avoid."""
    topic = dspy.InputField(); analogues = dspy.InputField()
    parties = dspy.OutputField()   # parsed → schemas.Party[]

# research/conversation.py — persona-driven asker ⇄ search-grounded expert (STORM ConvSimulator)
class AskFromParty(dspy.Signature):
    """As <party persona>, ask the next research question that would surface evidence
    bearing on this party's leverage/vulnerabilities. Stop when satisfied."""
    topic=dspy.InputField(); persona=dspy.InputField(); conversation=dspy.InputField()
    question = dspy.OutputField()

class GroundedAnswer(dspy.Signature):
    """Answer ONLY from retrieved sources. If unsupported, say so. Cite [n]. Never fabricate."""
    topic=dspy.InputField(); question=dspy.InputField(); sources=dspy.InputField()
    answer=dspy.OutputField(); queries=dspy.OutputField()

class ConvSimulator(dspy.Module):     # ⇄ DiscoveryResearcher's agentic loop, but STORM-structured
    def forward(self, topic, persona, max_turns): ...   # → dlg_history → curate.py → clues
```

`research/curate.py` turns each persona's dialogue into **distilled, multi-source, fact-checked clues** written into `clues`/`clue_versions` (same shape `EnrichmentAgent`/`SmartClueExtractor` produce today), and `research/mindmap.py` maintains the dynamic knowledge tree (Co-STORM `information_insertion_module`) surfaced as a knowledge map.

### 5. DB approach (reuse `dana.db`, zero-migration window)

- SQLAlchemy 2.0 Core/ORM **reflecting the existing schema** (don't redefine it from scratch — mirror `db/database.ts` column-for-column, including the JSON-as-TEXT columns and default `'[]'`/`'{}'`).
- `json_cols.JSONText` TypeDecorator so a Python list/dict round-trips to the same TEXT the TS `JSON.stringify` writes (so a row written by Python reads identically in the still-running TS backend and vice-versa).
- Pragmas on connect: `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`.
- **Single-writer discipline:** SQLite allows one writer. During side-by-side, route a given topic's pipeline to exactly one backend at a time (the run-registry/`activeRuns` already enforces "one run per topic" — we extend it to a cross-process advisory lock via an `app_settings` row `pipeline_owner:<topic_id>`). Reads are unrestricted.
- Python's **new** tables (compiled DSPy programs, optimization runs, eval results) live under an `alembic` migration that only `CREATE TABLE dspy_*` — it never alters TS-owned tables. Keeps the TS backend oblivious.

### 6. Async / SSE strategy & contract parity

- SSE via `sse_starlette.EventSourceResponse`. `events/bus.py` = `defaultdict[str, set[asyncio.Queue]]`; `subscribe(topic_id)` yields a queue, endpoint async-iterates it; `emit(topic_id, event)` puts to all queues; 15s `ping` task; cleanup on disconnect — a direct port of `routes/stream.ts` with the **same event JSON**.
- Pipeline runs are FastAPI `BackgroundTasks` / `asyncio.create_task` (mirrors the TS fire-and-forget `runDiscoverStage(...).then(...)` returning `{run_id, started_at, status:"started"}` immediately). The agentic/conversation loops are fully `async` (httpx).
- **Contract tests** (`tests/contract/`) are the safety net: a fixtures file lists every endpoint with method/params; tests assert Python responses are JSON-shape-equal to recorded TS responses (golden files captured from the live TS backend), and an SSE test asserts the event stream for a canned run matches the TS event sequence type-for-type. This is the literal definition of "parity."

### 7. DSPy eval / optimization loop (closes the scientific-rigor loop)

The real loop, using Dana's own calibration data:
1. `optimize/datasets.py` reads `forecast_resolutions` (Brier/log already stored) + `final_verdicts.scenarios_ranked` + the upstream `clues`/`forum` context → builds `dspy.Example`s `(topic context → ranked scenarios w/ probabilities)`, label = resolved outcome.
2. `optimize/metrics.py` exposes **Brier** and **log-score** as DSPy metrics (reuse `rigor/calibration.py`; same formulas as `db/queries/calibration.computeScores`).
3. `optimize/compile.py` runs `MIPROv2`/`BootstrapFewShot` over the scorer/curation modules to minimize Brier on held-out resolved topics; compiled programs are versioned to `data/dspy/<module>/<hash>.json` and recorded in a `dspy_compiled_programs` table. Modules load the latest compiled program at startup, falling back to the base signature.
4. `tests/eval/` runs the metric on a frozen eval split in CI so regressions in calibration are caught — same Brier number the `/api/calibration` endpoint surfaces.

### 8. Dev / prod (CLIProxyAPI + SearXNG stay)

Dev: run `uv run uvicorn dana.main:app --port 3001` against the **same** running CLIProxyAPI (`:8317`) and SearXNG (`:8080`) the TS stack already brought up; flip `vite.config.ts` proxy target to `:3001` to drive the React app from Python.

Prod compose — add one service, keep proxy/searxng shared:

```yaml
services:
  dana-py:
    build: { context: ., dockerfile: server-py/Dockerfile }
    environment:
      DATA_DIR: /data
      PROXY_BASE_URL: http://dana:8317      # reuse the TS container's bundled proxy (or split it out)
      SEARXNG_URL: http://searxng:8080
      FIRECRAWL_URL: ${FIRECRAWL_URL:-}
      PORT: "3001"
    ports: ["3001:3001"]
    volumes: ["./data:/data"]               # SAME dana.db, SAME .cli-proxy-api
    depends_on: { searxng: { condition: service_started } }
    networks: [dana-net]
```

`server-py/Dockerfile`: `FROM python:3.12-slim`, `COPY --from=ghcr.io/astral-sh/uv`, `uv sync --frozen`, `CMD uvicorn dana.main:app --host 0.0.0.0 --port 3001`. CLIProxyAPI stays exactly as pinned (v6.9.4 / the management-API contract is unchanged — Python's `proxy_admin.py` hits the same `/v0/management/*` endpoints with the same Bearer secret from `data/.management-secret`). At cutover, a tiny nginx/caddy (or the existing proxy) routes `/api → :3001` and static frontend, and the `dana` (TS) service is removed.

### 9. Phased roadmap (STORM-first) with acceptance criteria

**Phase 0 — Scaffold + plumbing + one trivial endpoint.**
Scope: `server-py/` skeleton, `pyproject`/`uv.lock`, `config.py`, `db/engine.py`+reflected `models.py`+`json_cols`, `llm/lm.py` (dspy.LM→proxy with fallback+rate-limit), `events/bus.py`, `api/stream.py`, and `GET /api/topics` + `GET/POST /api/topics/:id` + `GET /api/settings` reading real `dana.db`.
**Accept:** `uv run` boots on `:3001`; `GET /api/topics` returns the **identical JSON** to the TS backend for the same db (contract test green); SSE endpoint connects, emits `ping`, and a manual `emit()` reaches a subscriber; a one-line `vite.config` flip makes the existing React topic-list render unchanged; `dspy.LM` round-trips one completion through CLIProxyAPI with model-fallback proven (kill a provider → substitution logged).

**Phase 1 — STORM research engine (Discovery + Enrichment) end-to-end → clues.**
Scope: `research/{personas,conversation,retriever,curate,mindmap}`, `tools/{web_search,http_fetch,corpus}`, `agents/{discovery,enrichment}`, `pipeline/{runner,stages,state_manager,checkpoints}` for the first two gates, `api/pipeline.py` (`discover`,`enrich`,`status`), `api/parties.py`, `api/clues.py` (read + core CRUD).
**Accept:** `POST /api/topics/:id/pipeline/discover` runs persona-driven, search-grounded STORM discovery, writes `parties` (same columns/types) and transitions to `review_parties`; `enrich` produces grounded, cited, deduped `clues`/`clue_versions` (refuse-to-hallucinate verified by a no-source test → no clue invented); SSE emits `progress`/`think`/`clue_discovered`/`stage_complete` matching TS event shapes; corpus cache hits work; the React Discovery→Parties→Clues→knowledge-map views render against Python with **no frontend change**; versioning/forking parity (`/states` matches).

**Phase 2 — Forum + Scoring parity.**
Scope: `agents/{weight_calculator,forum_orchestrator,forum_supervisor,representative,scenario_scorer,expert}`, remaining `pipeline/stages` gates, `api/{forum,expert_council}.py`, `pipeline` endpoints `forum-prep/forum/score/analyze/reanalyze/run`.
**Accept:** full chain `forum-prep → forum → score` runs to `complete`; `forum_*`, `representatives`, `expert_councils/assessments/final_verdicts` rows match TS shapes; `forum_turn`/`expert_assessment`/`weight_result`/`verdict_content` SSE events match; `GET /forum`, `/representatives`, `/expert-council`, `/verdict` return frontend-renderable parity; a full pipeline produces a ranked verdict the React Forum/Verdict tabs display unchanged.

**Phase 3 — Calibration + steering + providers + DSPy optimization.**
Scope: `rigor/{dedup,base_rates,ensemble,calibration}`, `api/{calibration,providers,prompts}.py` + `providers/custom`, `llm/{steering,proxy_admin,prompt_loader}`, `optimize/{datasets,metrics,compile}`, eval CI.
**Accept:** `/api/calibration`, `/resolve`, `/resolution` reproduce Brier/log numbers identical to TS; provider list/OAuth-connect/disconnect/custom-provider all drive the same `/v0/management` API and reflect live credential state; steering blocks influence research/evidence/debate; `optimize/compile.py` produces a compiled scorer that **improves held-out Brier** vs the base program on resolved topics, loaded at startup, with the eval split guarded in CI.

**Phase 4 — Cutover.**
Scope: route `/api → :3001` (compose reverse-proxy), run both in parallel under shadow traffic, then remove the `dana` (TS) service; optionally split CLIProxyAPI into its own compose service so Python no longer depends on the TS container.
**Accept:** full contract-test suite green across **every** endpoint + SSE; a clean end-to-end topic (create → discover → enrich → analyze → score → resolve → calibration) runs entirely on Python producing equal-or-better results; frontend unchanged and pointed only at Python; TS backend container deleted; docs/README updated; `data/dana.db` continuity preserved (no data migration required).

Reference files studied (absolute paths): `/home/nima/dana/app/backend/src/pipeline/gatedPipeline.ts`, `/home/nima/dana/app/backend/src/db/database.ts`, `/home/nima/dana/app/backend/src/routes/{stream,pipeline,topics,calibration,providers,forum,settings}.ts`, `/home/nima/dana/app/backend/src/llm/{proxyClient,agenticLoop,modelCatalog}.ts`, `/home/nima/dana/app/backend/src/agents/DiscoveryAgent.ts`, `/home/nima/dana/app/frontend/{vite.config.ts,src/api/client.ts}`, `/home/nima/dana/{docker-compose.yml,Dockerfile,entrypoint.sh}`, `/home/nima/storm/knowledge_storm/storm_wiki/modules/{persona_generator,knowledge_curation}.py`, `/home/nima/storm/requirements.txt`.

---


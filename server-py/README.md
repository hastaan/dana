# Dana — Python + DSPy backend (`server-py/`)

A ground-up reimplementation of Dana's backend in **Python + FastAPI + DSPy**, built
**STORM-first** (perspective-driven, search-grounded research feeding a knowledge
mind-map) and living alongside the existing TS/Bun backend until parity cutover.

- **Architecture & roadmap:** [`docs/PLAN.md`](docs/PLAN.md)
- **Design review (26 findings + mitigations):** [`docs/REVIEW.md`](docs/REVIEW.md)

The React frontend and the existing `dana.db` are unchanged: this backend reimplements
the **same REST + SSE contract**, so pointing the frontend at it is a one-line Vite/
proxy flip. The current TS backend keeps running until the Python one reaches parity.

## Status

### Phase 0 — plumbing ✅
- FastAPI app (`uvicorn dana.main:app`) on `:3001`, open CORS.
- `GET /health`, `/api/topics`, `/api/topics/{id}`, `/api/models` — contract-matching JSON, real data.
- `GET /api/topics/{id}/stream` — SSE (unnamed events + 15s ping) via a thread-safe per-topic bus.
- Single LM chokepoint (`llm/lm.py`, `llm/dspy_lm.py`) → CLIProxyAPI with model-availability fallback.
- **DSPy → CLIProxyAPI typed-signature path proven** (`tests/smoke_dspy.py`).

### Phase 1 — STORM research engine ✅ (Discovery)
The centerpiece. `research/` implements STORM adapted to Dana's adversarial frame:
analogous-case survey → **personas (parties + analytical lenses)** → **grounded
analyst↔researcher conversations** (one question at a time, answers only from web
search, refuse-to-hallucinate) → **clue distillation**. Wired as the Discovery stage:
`POST /api/topics/{id}/pipeline/discover` → produces parties + clues persisted to the DB,
streaming `think`/`progress`/`clue_discovered`/`stage_complete` SSE events.
- Typed DSPy `Signature`s (Pydantic `OutputField`s) replace JSON-regex parsing.
- `tools/web_search.py` (SearXNG→Brave), corpus-cached retriever (`research/retriever.py`)
  dedupes fetches across conversations.
- Env-tunable budget (`DANA_RESEARCH_MAX_PERSONAS|MAX_TURNS|TOP_K|MAX_SEARCHES`).
- Verified end-to-end: `tests/smoke_research.py` (real SearXNG → grounded answers →
  distilled clues persisted). Quality sample: 10 parties + 6 lenses + 8-section outline.

### Phase 2 — scenario synthesis + scoring → verdict ✅
Closes the loop from clues to a probability-ranked verdict the React frontend renders.
- `agents/scenario_scorer.py` (DSPy): synthesize 3–6 distinct, mutually-exclusive outcome
  scenarios from the parties' agendas + the evidence, then score each — probability,
  confidence, reference-class **base rate** + reasoning, objective **resolution criteria**/
  date, key drivers, watch indicators, cited evidence chain. Probabilities normalized to
  1.0 in pure Python (the LLM is never trusted to make them sum).
- `rigor/dedup.py` (Enh 4e): **independent evidence density** — clusters clues by *primary*
  source domain so single-cluster corroboration reads as weak; fed to the scorer as a note.
- Wired as the scoring stage: `POST /api/topics/{id}/pipeline/{score,analyze,run}` →
  status `expert_council` → `complete`, streaming `verdict_content`. Verdict persisted to
  `expert_councils` + `final_verdicts`; readable via `GET /verdict[/:v]`, `/expert-council[/:v]`.
- `POST /pipeline/run` chains discovery → verdict in one shot.
- Verified end-to-end on the live dev DB (IRI-regime-collapse, 78 clues / 9 parties):
  6 grounded scenarios summing to 100%, each with base rate + resolution criteria, persisted
  and read back through `get_expert_council` with a coherent assessment (`tests/smoke_scoring.py`).

### Phase 3 — enrichment + full multi-party forum debate ✅
- **Enrichment** (`POST /pipeline/enrich`): the STORM engine re-aimed at the *existing*
  parties — deeper per-party grounded research distilling delta clues (deduped). Status
  `review_parties → enrichment → review_enrichment`.
- **Forum-prep** (`POST /pipeline/forum-prep`): the 5-factor influence model
  (military / economic / information / international / internal, each 0–100, evidence-grounded)
  → party `weight`; one debate **representative persona** per party with weight-proportional
  speaking budgets (low-weight parties keep a floor). Status → `review_forum_prep`.
- **Forum debate** (`POST /pipeline/forum`): a moderator frames the central question + points
  of contention, then each representative speaks **in character** across opening → rebuttal →
  closing, grounded in clue ids, challenging others by name. Turns persist to
  `forum_rounds`/`forum_turns`, stream as `forum_turn` SSE; endorsed outcomes aggregate into
  `forum_scenarios`; a synthesis writes the debate summary. Status → `review_forum`. The
  scorer now **builds on the debate** (summary + endorsements) when present.
- Read routes: `GET /forum[/:sessionId]`, `/representatives`. Bounded by
  `DANA_FORUM_MAX_PARTIES`. Verified: forum-prep produced 9 differentiated reps; debate ran
  opening/rebuttal/closing with grounded, in-character turns (`tests/smoke_forum.py`).

### Phase 4 — calibration · steering · providers · cutover ✅
- **Calibration** (`/api/calibration`, `POST /resolve`, `GET/DELETE /resolution`): resolve a
  topic's forecast → **Brier + log score**, plus a reliability curve across all resolutions.
- **Steering** (`/api/settings`): operator `AnalystGuidance` (framing / research / evidence /
  debate), global + per-topic, injected into discovery/forum/scoring prompts with a guardrail
  ("guides method, not the conclusion").
- **Providers** (`/api/providers/custom`, `/health`, `/models`): add/list/remove custom
  OpenAI- and Anthropic-compatible API-key providers through the CLIProxyAPI management API
  (keys never echoed — masked hint only). Lets an operator plug in e.g. a MiniMax key.
- **Cutover**: `Dockerfile` + `docker-compose.yml` + `run.sh` run the Python backend on `:3001`
  alongside the TS stack (non-destructive). With a built SPA present (`FRONTEND_DIST`) this one
  process serves the React app + API — a drop-in replacement. See **Cutover** below.

Deferred: DSPy optimization (no resolved-forecast data yet — bootstrap it via `/resolve`, then
compile the scorer against Brier; see REVIEW.md).

## Run it (dev)

Requires [uv](https://docs.astral.sh/uv/) and a running CLIProxyAPI on `:8317`.

```bash
cd server-py

# 1. Install (creates .venv, installs deps incl. DSPy)
uv venv && uv pip install -e '.[dspy]'

# 2. Dev DB: a COPY of the live dana.db (NEVER share the live file while the TS backend runs)
python - <<'PY'
import sqlite3
s = sqlite3.connect('../data/dana.db'); d = sqlite3.connect('data/dana.db')
s.backup(d); s.close(); d.close()
PY

# 3. Config: see .env (PROXY_BASE_URL, SEARXNG_URL, MANAGEMENT_SECRET, PORT=3001)

# 4. Run
.venv/bin/uvicorn dana.main:app --host 127.0.0.1 --port 3001 --reload

# 5. (optional) prove the DSPy path
.venv/bin/python tests/smoke_dspy.py
```

Or just `./run.sh` (sets up the venv, copies the DB, serves with autoreload).

### Drive the full pipeline

```bash
TID=$(curl -s localhost:3001/api/topics -H 'content-type: application/json' \
       -d '{"title":"Will X happen by 2026?","description":"…"}' | jq -r .id)
curl -s -XPOST localhost:3001/api/topics/$TID/pipeline/run          # discovery → enrich → forum-prep → forum → verdict
curl -s localhost:3001/api/topics/$TID/stream                       # watch SSE (think/forum_turn/verdict_content)
curl -s localhost:3001/api/topics/$TID/verdict | jq                 # ranked scenarios
```

Stages can also be run one gate at a time: `pipeline/{discover,enrich,forum-prep,forum,score}`.

## Cutover (point the frontend at the Python backend)

Non-destructive — the TS stack stays in the repo and keeps working.

- **Dev:** change the Vite dev-proxy target in `app/frontend/vite.config.ts` from
  `http://localhost:3000` to `http://localhost:3001`. No frontend code changes — it calls
  relative `/api/...`.
- **Prod (drop-in):** build the SPA (`cd app/frontend && bun run build`) and run the Python
  container with `FRONTEND_DIST` pointing at `app/frontend/dist` (or mount it) — this one
  process then serves the React app **and** the API:

  ```bash
  docker compose -f server-py/docker-compose.yml up --build   # API on :3001 (+ its own searxng on :8081)
  ```

  Point `PROXY_BASE_URL` at a running CLIProxyAPI (`:8317`). The compose mounts `server-py/data`
  (a **copy** of the DB) — never the live shared file while the TS backend is running.

## Layout

```
src/dana/
  main.py            # FastAPI app factory + lifespan
  config.py          # pydantic-settings (proxy, data dir, searxng, port)
  api/               # routers, 1:1 with the TS routes/ (same paths + JSON field names)
  events/bus.py      # thread-safe per-topic SSE pub/sub
  llm/lm.py          # single LM chokepoint -> CLIProxyAPI (+ model fallback)
  db/                # async reads + sync writers over the existing dana.db schema
  research/          # STORM engine (personas → grounded conversation → clue distillation)
  agents/            # DSPy modules: scenario_scorer, forum_prep (weights+reps), forum (debate)
  pipeline/          # stages: discovery, enrichment, forum_prep, forum, scoring (+ runner)
  rigor/             # independence dedup + calibration (Brier/log) — pure Python
  llm/               # lm chokepoint, dspy_lm, steering, proxy_admin (CLIProxyAPI mgmt)
docs/PLAN.md docs/REVIEW.md
tests/smoke_{dspy,research,scoring,forum}.py
```

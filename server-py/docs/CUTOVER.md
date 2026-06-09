# Cutover readiness — TS (Bun/Elysia) → server-py (FastAPI/DSPy)

**This is an assessment, not a change in behavior.** Nothing here flips a switch. It records,
honestly, where `server-py/` stands against the *running* TS app, what it still lacks, the
risks, and the concrete step-by-step procedure (and rollback) for when the team chooses to cut
over. Snapshot date: **2026-06**. Verify against live contract tests before acting.

The frontend is the immovable contract: React calls a relative `/api` base and a bare
`EventSource` with `es.onmessage` (no named SSE events). "Point the frontend at Python" is
therefore a one-line Vite/reverse-proxy target flip — *if and only if* paths, methods, query
params, JSON field names, and the unnamed `data:` SSE event types match verbatim.

---

## 1. Feature-parity matrix

Legend: ✅ at parity (verify with contract tests) · ◐ partial / lite · ✗ not yet in server-py ·
➕ server-py ahead of TS.

| Capability | TS (running, `:3000`) | server-py (`:3001`) | Status | Notes / gap |
|---|---|---|---|---|
| **Topics CRUD + versions/forking** | `topics.ts` | `api/topics.py` | ✅ | Same `dana.db` schema; `?version=` snapshot reads ported. Re-verify forking. |
| **Discovery** (parties) | `pipeline.ts` discover | `pipeline.py` `/discover` | ✅ | STORM persona-driven, search-grounded. |
| **Enrichment** (clues) | `pipeline.ts` enrich | `pipeline.py` `/enrich` | ✅ | Grounded, cited, deduped; refuse-to-hallucinate. |
| **Clues read** | `clues.ts` (read + CRUD) | folded into `topics.py` reads | ◐ | server-py serves clue *reads* via topic endpoints; standalone clue **CRUD** (manual add/edit/delete) not confirmed ported. |
| **Parties read** | `parties.ts` (read + CRUD) | folded into `topics.py` reads | ◐ | Same: reads yes; verify manual party CRUD endpoints. |
| **Forum prep** (weights) | `pipeline.ts` forum-prep | `pipeline.py` `/forum-prep` | ✅ | WeightCalculator; budget math pure-Python. |
| **Forum** (debate) | `forum.ts` + orchestrator | `pipeline.py` `/forum`, reads in `topics.py` `/forum` | ◐ | server-py runs a forum stage and reads sessions; the *full multi-turn adversarial* debate is "forum-lite" in places (see scenario_scorer docstring) — confirm turn-for-turn SSE parity. |
| **Scoring / verdict** | `expertCouncil.ts` + scorer | `pipeline.py` `/score` + `agents/scenario_scorer.py` | ◐ | Produces a ranked verdict end-to-end; Phase-2 "forum-lite" synthesis vs the full ensemble scorer with uncertainty bands. |
| **Expert council read** | `expertCouncil.ts` | `topics.py` `/expert-council` | ✅ | `final_verdicts` shape matched. |
| **Calibration** (Brier/log/reliability) | `calibration.ts` | `api/calibration.py` + `rigor/calibration.py` | ✅ | Brier/log ported; `/resolve`, `/resolution`, `/api/calibration` present. Verify numbers identical. |
| **Steering** (guardrailed guidance) | `steering.ts` | `llm/steering.py` | ✅ | Injected as runtime input; epistemic-only contract preserved. |
| **Providers** (list/OAuth/disconnect) | `providers.ts` | `api/providers.py` | ✅ | Drives the `/v0/management` API. |
| **Custom providers** | `customProviders.ts` | `api/providers.py` `/providers/custom*` | ✅ | Upsert/list/delete/status. |
| **Settings** | `settings.ts` | `api/settings.py` | ✅ | |
| **Models / catalog** | `index.ts` `/api/models*` | `api/models.py` | ✅ | Availability fallback ported. |
| **SSE stream** | `stream.ts` (10 unnamed event types) | `api/stream.py` + `events/bus.py` | ✅ | In-process pub/sub; verify all of `think\|progress\|forum_turn\|expert_assessment\|verdict_content\|weight_result\|clue_discovered\|stage_complete\|error\|ping`. |
| **Research route** (`/api/research/lookup`) | `research.ts` (POST; new, untracked) | `api/internet.py` (POST + `/lookup/stream` SSE) | ➕ | server-py adds an SSE-traced variant + output cache + tiers. Confirm POST response body shape matches the TS `ResearchPage.tsx` expects. |
| **Prompts API** (`/api/prompts`, tool-catalog, `:name`, reset) | `prompts.ts` + `seedDefaults` | — | ✗ **GAP** | No `prompts` router in server-py. The editable-`.md` prompt CRUD + tool catalog + optimizer write-back loop is **not yet ported**. If the frontend exposes a prompt editor, those calls 404 on Python. |
| **DSPy optimization** | n/a (TS tunes prompts by hand) | `optimize/scorer_opt.py` (NEW scaffold) | ◐ offline | `build_trainset()` + `brier_metric` + `optimize_scorer()`. Offline/opt-in, **NO-OP** until ≥8 resolved forecasts; not wired into startup or CI. |
| **Auth middleware** | `middleware/auth.ts` | `api/auth.py` `ApiTokenMiddleware` | ✅ | Env-gated bearer token; `?token=` exempt on `/stream`. |
| **SPA serving** | static `../frontend/dist` | `main.py` `FRONTEND_DIST` mount (LAST) | ✅ | Either serve via Python or keep Vite/reverse-proxy. |

---

## 2. What server-py still lacks vs the running TS app

1. **Prompts API + prompt-editor write-back (hard blocker if used).** No `/api/prompts*`
   router exists. The TS app seeds defaults and exposes tool-catalog / per-prompt GET / reset.
   Any frontend prompt-editing surface will 404 against Python. This is the largest *functional*
   parity gap.
2. **Forum/scoring fidelity is "forum-lite" in spots.** The end-to-end verdict is produced, but
   the full multi-turn chairman/representative adversarial debate and the ensemble scorer with
   uncertainty bands are not yet confirmed turn-for-turn identical. Needs contract + golden tests.
3. **Standalone clue/party CRUD.** Reads are served; confirm the manual add/edit/delete endpoints
   the TS `clues.ts`/`parties.ts` expose exist (or that the frontend never calls them).
4. **DSPy optimization is a scaffold, not a loop.** `optimize/scorer_opt.py` is offline-only and
   NO-OPs (< 8 resolved forecasts). It is not loaded at startup, has no held-out eval split, and
   no CI guardrail-regression probe. This does **not** block cutover (TS has no optimizer either),
   but the PLAN's Phase-3 acceptance ("compiled scorer improves held-out Brier, loaded at startup,
   eval guarded in CI") is not yet met.
5. **Golden contract-test coverage.** Parity is only as real as the recorded TS-vs-Python response
   diffs. Treat any ✅/◐ above as *claimed* until `tests/contract/` is green for that endpoint and
   the SSE byte-stream matches.

---

## 3. Risks

- **Shared `dana.db` + SQLite single-writer.** Both backends point at one file during a migration
  window. SQLite allows one writer at a time; two backends both running pipelines on the *same*
  live DB risks `database is locked` and interleaved writes. The server-py compose **deliberately
  mounts a COPY** (`./data:/data`, commented "never the live shared data dir while TS runs"). So
  the safe default is: do **not** dual-write the live DB. Either (a) only one backend writes at a
  time, or (b) use the advisory `pipeline_owner:<topic_id>` lock the PLAN describes before any
  concurrent-write window.
- **Silent SSE shape drift.** The `EventSource` is unnamed-event and field-name sensitive. A
  missing field or a renamed key breaks the live view with no error. Highest-value test surface.
- **Prompts 404s.** If the running frontend has a prompt editor, cutover without the prompts API
  degrades that screen. Decide: port `/api/prompts*`, or hide the editor, before flipping.
- **Provider/credential state.** Cutover must not echo key-bearing bodies and must reflect live
  proxy credential state; mis-cutover could show stale "connected" status.
- **Forum/verdict regressions are subtle.** A worse-but-not-broken verdict won't 500 — it just
  produces different probabilities. Needs golden-output comparison, not just status-200 checks.
- **DB schema drift via new Python-only tables.** Any `optimize`/eval tables must be additive
  (`CREATE TABLE dspy_*` only) and never alter TS-owned tables.

---

## 4. Cutover procedure (step-by-step)

Prereqs before starting: full contract-test suite green for every endpoint + SSE; a clean
end-to-end topic (create → discover → enrich → forum → score → resolve → calibration) runs on
Python with equal-or-better output; the prompts-API decision made (port it or hide the editor).

### Phase A — Shadow (no user impact)
1. Bring up server-py alongside TS: `docker compose -f server-py/docker-compose.yml up --build`
   (Python on `:3001`, its own searxng on host `:8081`; CLIProxyAPI shared at `:8317`).
2. Point server-py at a **COPY** of the DB (the default `./server-py/data` mount) — do **not**
   let two backends write the live `dana.db` concurrently. Run shadow topics on the copy.
3. Run the contract suite against `:3001`; diff responses + SSE streams vs `:3000`. Fix drift.

### Phase B — Dev flip (frontend → Python)
4. In `app/frontend/vite.config.ts`, change the dev proxy target
   `'/api': 'http://localhost:3000'` → `'http://localhost:3001'`. Restart Vite. No frontend code
   changes. Exercise every screen (discovery, parties, clues, forum, verdict, calibration,
   providers, settings, research, and the prompt editor if present).

### Phase C — Single-writer cutover on the live DB
5. Stop new pipeline runs on TS. Quiesce: ensure no in-flight TS run is writing.
6. **Data step (no migration needed):** the schema is byte-compatible and shared, so there is
   **no data migration** — just stop pointing two writers at one file. Take a backup
   (`cp data/dana.db data/dana.db.bak-<date>`), then point server-py's `DATA_DIR` at the live
   data dir (instead of the copy) so Python becomes the sole writer. Restart server-py.
7. **Prod serving flip (choose one):**
   - *Reverse-proxy:* change the prod `/api` (and `/stream`) upstream from `:3000` → `:3001`.
   - *Single-process SPA:* `bun run build` the frontend, set `FRONTEND_DIST` to the built
     `app/frontend/dist`, and serve the SPA directly from server-py (`main.py` mounts it LAST so
     `/api/*` wins). Then the Python process replaces the TS server entirely.
8. Smoke-test the full flow against the live DB. Confirm SSE, verdicts, calibration numbers.

### Phase D — Decommission
9. Run both under shadow traffic for a soak period, then remove the `dana` (TS) service from the
   root `docker-compose.yml`. Optionally split CLIProxyAPI into its own compose service so Python
   no longer depends on the TS container.

## 5. Rollback

Each phase is independently reversible; nothing above is destructive if the DB backup exists.
- **Phase B:** revert the one-line Vite proxy target back to `:3000`.
- **Phase C/D:** point the reverse-proxy `/api` upstream back to `:3000` (or restart the TS
  service), restore `data/dana.db` from `data/dana.db.bak-<date>`, and revert server-py's
  `DATA_DIR` to the copy. Because the schema is shared and unchanged, rollback is a target flip
  plus (if Python wrote to the live DB) a DB-file restore — no reverse migration.

---

## 6. Conclusion (5-line summary)

1. **Core path is essentially at parity** (topics/discovery/enrichment/forum/scoring/calibration/
   steering/providers/SSE) and the research route is actually *ahead* (adds SSE + cache + tiers).
2. **The one real functional gap is the Prompts API** (`/api/prompts*`) — server-py has no prompts
   router, so any frontend prompt editor 404s until it's ported or hidden.
3. **DSPy optimization is a deliberate offline scaffold, not a blocker:** `optimize/scorer_opt.py`
   NO-OPs until ≥8 forecasts resolve and isn't wired into startup/CI (Phase-3 accept unmet).
4. **The cutover itself is a one-line proxy flip plus a single-writer DB handoff** — no data
   migration (shared byte-compatible schema), fully reversible via target flip + DB backup.
5. **Recommendation: NOT yet ready to flip.** First close the prompts gap (or hide it), then make
   parity *real* via green golden/contract tests on every endpoint + the SSE byte-stream before
   touching the live DB.

---

## 7. How to run the dev flip + pyserve

Two practical mechanics for Phase B/C above: a **contract-diff probe** to prove parity, a
**dev proxy flip** to point the frontend at Python, and **`dana pyserve`** to run the Python
backend *as the whole served app* (Python serves the SPA too — no TS container).

### 7.1 Contract-diff probe (`server-py/tests/contract_diff.py`)

A read-only, stdlib-only harness that hits the SAME GET endpoints on TS (`:3000`) and
server-py (`:3001`) and prints a per-endpoint **PASS / DIFF / UNREACHABLE** report: status-code
match plus a recursive JSON *shape* (key-set + leaf-type) diff with volatile fields (timestamps,
ids, versions, durations, …) ignored. It compares response **structure, not values** — it is a
parity probe, not a golden test. It never runs the pipeline, never calls an LLM/web-search, and
**does not require both servers up** (a down server is reported `unreachable`, never crashes).

```bash
# both backends up (e.g. TS via `dana start`, Python via server-py/docker-compose.yml):
python server-py/tests/contract_diff.py <TOPIC_ID>

# override ports / send an auth token if the backends are gated:
BASE_TS=http://localhost:3000 BASE_PY=http://localhost:3001 \
  DANA_API_TOKEN=… python server-py/tests/contract_diff.py <TOPIC_ID>
```

Endpoints probed: `/api/topics`, `/api/topics/:id`, `…/parties`, `…/clues`, `…/verdict`,
`…/expert-council`, `…/representatives`, `…/forum`, `/api/calibration`, `/api/settings`,
`/api/providers/custom`, `/api/prompts`, `/api/prompts/tool-catalog`, `/api/health`. Exit code is
`1` if any reachable pair DIFFs, else `0`. Expect `/api/prompts*` to DIFF until that router is
ported (the known gap in §2) — both should otherwise PASS once parity holds.

### 7.2 Dev flip (frontend → Python), unchanged from Phase B

In `app/frontend/vite.config.ts`, change the dev proxy target `'/api': 'http://localhost:3000'`
→ `'http://localhost:3001'`, restart Vite, exercise every screen. One-line revert to roll back.

### 7.3 `dana pyserve` — Python backend serving the whole app

The root `docker-compose.yml` carries an **opt-in** `server-py` service behind a compose
`pyserve` profile, so a plain `docker compose up` / `dana start` is **unchanged** (the service is
absent unless the profile is active). When active it builds `./server-py`, serves on `:3001`, and
— via `FRONTEND_DIST` (bind-mounted from `app/frontend/dist`) — serves the built React SPA itself
(`main.py` mounts the SPA LAST so `/api/*` still wins). The result: the whole app runs on the
Python backend, no TS container needed.

```bash
# build the SPA into app/frontend/dist if missing, then build+start server-py:
dana pyserve            # → http://localhost:3001  (SPA + /api + /stream, all Python)
dana logs server-py     # watch it
dana pyserve-stop       # stop just the Python service; rest of the stack stays up

# equivalent raw compose (no SPA auto-build):
docker compose --profile pyserve up -d --build server-py
docker compose --profile pyserve stop server-py
```

Notes: `dana pyserve` requires `bun` only the first time (to build the SPA); thereafter it reuses
the existing `app/frontend/dist`. The service mounts a **COPY** of the DB (`./server-py/data`),
never the live shared `./data`, while the TS backend runs — honoring the SQLite single-writer risk
in §3. `PROXY_BASE_URL` defaults to the root `dana` container's proxy (`http://dana:8317`) on the
shared compose network; override it in `.env` to point elsewhere.

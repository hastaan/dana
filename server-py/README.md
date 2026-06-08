# Dana — Python + DSPy backend (`server-py/`)

A ground-up reimplementation of Dana's backend in **Python + FastAPI + DSPy**, built
**STORM-first** (perspective-driven, search-grounded research feeding a knowledge
mind-map) and living alongside the existing TS/Bun backend until parity cutover.

- **Architecture & roadmap:** [`docs/PLAN.md`](docs/PLAN.md)
- **Design review (26 findings + mitigations):** [`docs/REVIEW.md`](docs/REVIEW.md)

The React frontend and the existing `dana.db` are unchanged: this backend reimplements
the **same REST + SSE contract**, so pointing the frontend at it is a one-line Vite/
proxy flip. The current TS backend keeps running until the Python one reaches parity.

## Status — Phase 0 (plumbing) ✅

Running and verified:
- FastAPI app (`uvicorn dana.main:app`) on `:3001` with open CORS.
- `GET /health`, `GET /api/topics`, `GET /api/topics/{id}`, `GET /api/models` — contract-matching JSON, real data from the DB.
- `GET /api/topics/{id}/stream` — SSE with the unnamed-event + 15s-ping contract.
- Thread-safe per-topic event bus (`events/bus.py`), single LM chokepoint (`llm/lm.py`) → CLIProxyAPI with model-availability fallback.
- **DSPy → CLIProxyAPI typed-signature path proven** (`tests/smoke_dspy.py`): a `dspy.Signature` returns typed fields through `minimax-m3`, replacing the TS backend's JSON-regex parsing.

Next: Phase 1 = the STORM research engine (Discovery + Enrichment) end-to-end producing clues; then forum + scoring parity; then calibration/steering/providers; then DSPy optimization (deferred until resolved-forecast data exists — see REVIEW.md) and cutover.

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

Point the frontend at the Python backend by changing the Vite dev-proxy target from
`http://localhost:3000` to `http://localhost:3001` (no frontend code changes).

## Layout

```
src/dana/
  main.py            # FastAPI app factory + lifespan
  config.py          # pydantic-settings (proxy, data dir, searxng, port)
  api/               # routers, 1:1 with the TS routes/ (same paths + JSON field names)
  events/bus.py      # thread-safe per-topic SSE pub/sub
  llm/lm.py          # single LM chokepoint -> CLIProxyAPI (+ model fallback)
  db/                # async SQLAlchemy over the existing dana.db schema
  pipeline/ research/ agents/ rigor/ optimize/ tools/ schemas/   # filled in by later phases
docs/PLAN.md docs/REVIEW.md
tests/smoke_dspy.py
```

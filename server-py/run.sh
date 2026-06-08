#!/usr/bin/env bash
# Dev runner for the Python + DSPy backend. Idempotent: sets up the venv, refreshes a COPY
# of the live DB (never the shared file), and serves on :3001 with autoreload.
set -euo pipefail
cd "$(dirname "$0")"

# 1. venv + deps (DSPy extra)
[ -d .venv ] || uv venv
uv pip install -q -e '.[dspy]'

# 2. Dev DB: a COPY of the live dana.db (skip if you already have one you want to keep)
if [ ! -f data/dana.db ] && [ -f ../data/dana.db ]; then
  mkdir -p data
  .venv/bin/python - <<'PY'
import sqlite3
s = sqlite3.connect('../data/dana.db'); d = sqlite3.connect('data/dana.db')
s.backup(d); s.close(); d.close()
print("copied ../data/dana.db -> data/dana.db")
PY
fi

# 3. Serve (reads .env for PROXY_BASE_URL, SEARXNG_URL, MANAGEMENT_SECRET, PORT)
exec .venv/bin/uvicorn dana.main:app --host 0.0.0.0 --port "${PORT:-3001}" --reload --app-dir src

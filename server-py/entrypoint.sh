#!/bin/sh
# Self-contained entrypoint for the Python (FastAPI/DSPy) backend: it runs CLIProxyAPI
# (the OAuth + custom-provider management proxy) IN THIS CONTAINER and then the API, so
# the proxy is always reachable at 127.0.0.1:8317 and Dana runs as a single container on
# :3000 with NO separate TS backend. Adapted from the old TS entrypoint.sh.
set -eu

child_pids=""
cleanup() { for pid in $child_pids; do kill "$pid" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap cleanup TERM INT

mkdir -p "${DATA_DIR:-/data}/.cli-proxy-api"

# Management secret — enables the CLIProxyAPI /v0/management endpoints (custom providers from
# the UI). Generated once and persisted (owner-only) so it survives restarts; the backend reads
# it from the env we export here.
SECRET_FILE="${DATA_DIR:-/data}/.management-secret"
if [ -z "${MANAGEMENT_SECRET:-}" ]; then
  if [ -f "$SECRET_FILE" ]; then
    MANAGEMENT_SECRET="$(cat "$SECRET_FILE")"
  else
    MANAGEMENT_SECRET="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    (umask 077; printf '%s' "$MANAGEMENT_SECRET" > "$SECRET_FILE")
  fi
fi
export MANAGEMENT_SECRET
ESCAPED_SECRET="$(printf '%s' "$MANAGEMENT_SECRET" | sed "s/'/''/g")"

# CRITICAL: the proxy config lives on the persistent volume, NOT /tmp — CLIProxyAPI writes
# UI-added providers (and their API keys) back into the exact config file it started with, so
# an ephemeral file loses every custom provider on restart. Generate only if absent (so
# proxy-written entries survive); ensure the remote-management block exists on older configs.
CONFIG_FILE="${DATA_DIR:-/data}/cli-proxy-config.yaml"
if [ ! -f "$CONFIG_FILE" ]; then
  cat > "$CONFIG_FILE" <<EOF
port: 8317
auth-dir: "${DATA_DIR:-/data}/.cli-proxy-api"
remote-management:
  allow-remote: false
  secret-key: '${ESCAPED_SECRET}'
EOF
elif ! grep -qE '^[[:space:]]*remote-management:' "$CONFIG_FILE"; then
  cat >> "$CONFIG_FILE" <<EOF
remote-management:
  allow-remote: false
  secret-key: '${ESCAPED_SECRET}'
EOF
fi
chmod 600 "$CONFIG_FILE" 2>/dev/null || true

/usr/local/bin/CLIProxyAPI -config "$CONFIG_FILE" &
child_pids="$child_pids $!"

# Wait for the proxy to answer before starting the API (so model lookups don't race).
i=0
while [ "$i" -lt 30 ]; do
  if wget -qO- http://127.0.0.1:8317/v1/models >/dev/null 2>&1; then break; fi
  i=$((i + 1)); sleep 1
done

echo "Dana (Python) available at http://localhost:${PORT:-3000}"
exec uvicorn dana.main:app --host 0.0.0.0 --port "${PORT:-3000}" --app-dir src

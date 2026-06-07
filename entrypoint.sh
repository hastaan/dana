#!/bin/sh
set -eu

child_pids=""

cleanup() {
  for pid in $child_pids; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}

trap cleanup TERM INT

mkdir -p "${DATA_DIR:-/data}/.cli-proxy-api"

# Management API secret — enables the CLIProxyAPI /v0/management endpoints so Dana
# can add custom providers from the UI. Generated once and persisted (owner-only) so
# it stays stable across restarts; the backend sends it as the Bearer token.
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

# Single-quote-escape for safe YAML embedding (handles externally-supplied secrets
# that may contain quotes/backslashes).
ESCAPED_SECRET="$(printf '%s' "$MANAGEMENT_SECRET" | sed "s/'/''/g")"

# CRITICAL: the proxy config must live on the persistent volume, NOT /tmp.
# CLIProxyAPI writes UI-added providers (and their API keys) back into the exact
# config file it was started with, so an ephemeral file loses every custom provider
# on restart. Generate only if absent (so proxy-written entries survive); ensure the
# remote-management block exists on older configs. allow-remote is false: backend and
# proxy share this container → management calls come over loopback (127.0.0.1).
CONFIG_FILE="${DATA_DIR:-/data}/cli-proxy-config.yaml"
if [ ! -f "$CONFIG_FILE" ]; then
  cat > "$CONFIG_FILE" <<EOF
port: 8317
auth-dir: "${DATA_DIR:-/data}/.cli-proxy-api"
remote-management:
  allow-remote: false
  secret-key: '${ESCAPED_SECRET}'
EOF
elif ! grep -q "remote-management" "$CONFIG_FILE"; then
  cat >> "$CONFIG_FILE" <<EOF
remote-management:
  allow-remote: false
  secret-key: '${ESCAPED_SECRET}'
EOF
fi
chmod 600 "$CONFIG_FILE" 2>/dev/null || true
# Used by the provider OAuth login flow (routes/providers.ts) so it edits the same file.
export CLIPROXY_CONFIG="$CONFIG_FILE"

/usr/local/bin/CLIProxyAPI -config "$CONFIG_FILE" &
proxy_pid=$!
child_pids="$child_pids $proxy_pid"

i=0
while [ "$i" -lt 30 ]; do
  if wget -qO- http://127.0.0.1:8317/v1/models >/dev/null; then
    break
  fi
  i=$((i + 1))
  sleep 1
done

echo "Dana available at http://localhost:${PORT:-3000}"
exec bun run app/backend/src/index.ts

# Dana — SELF-CONTAINED app image: Python (FastAPI/DSPy) backend + bundled CLIProxyAPI + the
# built React SPA, all in one container serving :3000. Replaces the old TS backend entirely.
# BUILD CONTEXT = repo root (so it can bake the frontend): docker build -f server-py/Dockerfile .

# CLIProxyAPI binary (glibc-linked; runs on the Debian python:slim base, not alpine).
FROM eceasy/cli-proxy-api:latest AS proxy

# Build the React SPA.
FROM oven/bun:1-alpine AS fe
WORKDIR /fe
COPY app/frontend/ ./
RUN bun install && bun run build

FROM python:3.12-slim
# libxml2/libxslt for trafilatura/lxml; wget for the entrypoint proxy-readiness probe + healthcheck.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libxml2 libxslt1.1 ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
COPY --from=proxy /CLIProxyAPI/CLIProxyAPI /usr/local/bin/CLIProxyAPI
RUN chmod +x /usr/local/bin/CLIProxyAPI

WORKDIR /app
COPY server-py/pyproject.toml ./
COPY server-py/src ./src
RUN uv pip install --system --no-cache -e '.[dspy]'
COPY server-py/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
COPY --from=fe /fe/dist /app/frontend/dist

ENV PORT=3000 \
    DATA_DIR=/data \
    PROXY_BASE_URL=http://127.0.0.1:8317 \
    SEARXNG_URL=http://searxng:8080 \
    FIRECRAWL_URL="" \
    FRONTEND_DIST=/app/frontend/dist
EXPOSE 3000 8317
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:${PORT:-3000}/health || exit 1
STOPSIGNAL SIGTERM
VOLUME ["/data"]

CMD ["/app/entrypoint.sh"]

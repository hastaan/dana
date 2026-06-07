# syntax=docker/dockerfile:1.7

# Pinned to v6.9.4 — Dana's provider/custom-provider management is built against this
# version's management API (/v0/management/openai-compatibility, /claude-api-key,
# /auth-files, *-auth-url). Newer "latest" (v7.x) removed some of those endpoints, so
# do NOT float to :latest without re-validating routes/providers.ts + routes/customProviders.ts.
FROM eceasy/cli-proxy-api@sha256:dbb1bc7d77f77aa1e9676872af15e18970ab30162649480126efc62ced224f11 AS proxy

FROM oven/bun:1-alpine AS builder
WORKDIR /app

COPY app/frontend/package.json app/frontend/bun.lock app/frontend/
RUN cd app/frontend && bun install --frozen-lockfile

COPY app/frontend/ app/frontend/
RUN cd app/frontend && bun run build

FROM oven/bun:1-alpine
WORKDIR /app
ENV PORT=3000 DATA_DIR=/data PROXY_BASE_URL=http://127.0.0.1:8317 SEARXNG_URL=http://searxng:8080 FIRECRAWL_URL="" FIRECRAWL_API_KEY=""

COPY --from=proxy /CLIProxyAPI/CLIProxyAPI /usr/local/bin/CLIProxyAPI
RUN chmod +x /usr/local/bin/CLIProxyAPI

COPY app/backend/package.json app/backend/bun.lock app/backend/
RUN cd app/backend && bun install --frozen-lockfile --production

COPY app/backend/ app/backend/
COPY --from=builder /app/app/frontend/dist /app/app/frontend/dist
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

EXPOSE 3000 8317 54545 1455
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:${PORT:-3000}/health || exit 1
STOPSIGNAL SIGTERM
VOLUME ["/data"]

CMD ["/app/entrypoint.sh"]

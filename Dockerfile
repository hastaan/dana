# syntax=docker/dockerfile:1.7

# CLIProxyAPI provides the OAuth + custom-provider management API that Dana drives
# (/v0/management/{openai-compatibility,claude-api-key,auth-files,*-auth-url}). These
# endpoints only register when remote-management.secret-key is set — the entrypoint
# does that. Tracks :latest (validated against v7.1.x and v6.9.x).
FROM eceasy/cli-proxy-api:latest AS proxy

FROM oven/bun:1-alpine AS builder
WORKDIR /app

COPY app/frontend/package.json app/frontend/bun.lock app/frontend/
RUN cd app/frontend && bun install --frozen-lockfile

COPY app/frontend/ app/frontend/
RUN cd app/frontend && bun run build

# glibc (Debian) runtime — the CLIProxyAPI binary (v7.x) is dynamically linked against
# glibc, so it can't run on a musl/alpine base. wget is needed by the healthcheck and
# the entrypoint's proxy-readiness probe.
FROM oven/bun:1
RUN apt-get update && apt-get install -y --no-install-recommends wget ca-certificates && rm -rf /var/lib/apt/lists/*
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

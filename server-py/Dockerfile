# Dana — Python + DSPy backend. Slim runtime; uv for fast, reproducible installs.
FROM python:3.12-slim

# trafilatura/lxml need libxml2/libxslt at runtime; build-essential for any wheels w/o binaries.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libxml2 libxslt1.1 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
# Editable install with the DSPy extra (research + scoring engines).
RUN uv pip install --system --no-cache -e '.[dspy]'

ENV PORT=3001 \
    DATA_DIR=/data \
    PROXY_BASE_URL=http://host.docker.internal:8317 \
    SEARXNG_URL=http://searxng:8080
EXPOSE 3001

# Set FRONTEND_DIST (or mount the built SPA to /app/frontend-dist) for full-cutover SPA serving.
CMD ["sh", "-c", "uvicorn dana.main:app --host 0.0.0.0 --port ${PORT}"]

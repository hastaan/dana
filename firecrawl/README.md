# localfirecrawl — opt-in Playwright-grade fetch for Dana

[localfirecrawl](https://github.com/teelaitila/localfirecrawl) gives Dana a
Firecrawl-compatible scrape API (Playwright-rendered, **no API key**) for
JS-heavy / anti-bot / paywalled pages. Both Dana backends already call
`FIRECRAWL_URL` → `POST /v1/scrape` and fall back to Jina/Readability when it is
unset (`app/backend/src/tools/external/httpFetch.ts`,
`server-py/src/dana/tools/http_fetch.py`), so enabling this is **ops-only** — no
code changes.

It is a **heavy build-from-source stack** (3× Tor proxies + a `playwright-service`
Chromium worker + a Firecrawl `api` + `worker` + valkey/redis + its own SearXNG),
so it is **opt-in** and not part of `dana start`. The **first build is slow**
(compiles the Firecrawl api/worker and pulls Chromium); subsequent starts are fast.

## Start / stop

From the repo root (the `dana` CLI drives everything):

```bash
dana firecrawl        # clone localfirecrawl into firecrawl/localfirecrawl (if missing),
                      # seed its .env (PORT=3002), then build + start in the background
dana firecrawl-logs   # follow logs (mainly to watch the first build)
dana firecrawl-stop   # stop + remove the stack
```

`dana firecrawl` is equivalent to:

```bash
git clone https://github.com/teelaitila/localfirecrawl firecrawl/localfirecrawl   # first run only
docker compose -f firecrawl/docker-compose.yml up -d --build
```

## How Dana reaches it

The upstream `api` service publishes the Firecrawl REST API on **host port 3002**
(`PORT` in the clone's `.env`). Dana reaches it **through the host**, not a shared
Docker network:

```
FIRECRAWL_URL=http://host.docker.internal:3002
```

That default is already wired into the `dana` service in the root
`docker-compose.yml` and `server-py/docker-compose.yml` (with a `host-gateway`
`extra_hosts` entry), so once localfirecrawl is up Dana uses it automatically.
Override `FIRECRAWL_URL` in `.env` if you publish it elsewhere.

## Notes

- `firecrawl/docker-compose.yml` is a thin wrapper: it `include:`s localfirecrawl's
  own compose from the clone so service/build/dep definitions stay in sync with
  upstream. We do **not** vendor or fork its source.
- The clone lives at `firecrawl/localfirecrawl/` and is **git-ignored** — it is a
  large external checkout, not part of this repo.
- localfirecrawl runs its **own** SearXNG (on host 8081 by default); that is
  internal to the scrape stack and unrelated to Dana's SearXNG. If 8081 clashes
  with `server-py`'s SearXNG, only run one of those stacks at a time.

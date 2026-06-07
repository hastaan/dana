# Dana

Dana is an AI-powered geopolitical scenario analysis platform. Users create topics around geopolitical questions, and the system researches, debates, and scores possible outcomes through a multi-stage AI pipeline with 12+ specialized agents.

---

## Features

- **Multi-stage analysis pipeline** -- 5-stage lifecycle (Discovery, Enrichment, Weight Calculation, Forum, Scenario Scoring) with checkpoint-based resumability
- **Multi-agent architecture** -- 12+ AI agents including researchers, fact-checkers, forum representatives, devil's advocates, and expert scorers
- **Dark-mode-first UI** built with shadcn/ui and TailwindCSS 4
- **Multi-provider LLM support** via CLIProxyAPI with OAuth-based provider authentication, plus **custom API-key providers** (OpenAI- or Anthropic-compatible base URLs, e.g. MiniMax) managed from the UI
- **Operator steering** -- inject epistemic *analyst guidance* (per-topic or global) that steers how agents research, weigh evidence, and debate (the chairman) to resist propaganda/fake news — without dictating conclusions; recorded on each verdict
- **Scientific rigor** -- evidence-independence de-duplication (correlated sources don't inflate confidence), reference-class base rates, optional scoring ensembles with uncertainty bands, and **Brier/log-score calibration** against resolved outcomes
- **Playwright-rendered scraping** (optional) via a Firecrawl/localfirecrawl backend, with Jina/Readability fallback
- **Configurable settings** -- providers and models, system prompts (inline editor), agents and tools (toggle/configure), pipeline defaults, steering, calibration
- **Real-time updates** via Server-Sent Events during pipeline execution
- **Demo analysis** seeded on first run so a fresh install shows a real worked example
- **Docker Compose deployment** (app + SearXNG; optional Firecrawl) with built-in health checks

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Bun >= 1.0 |
| Backend | Elysia (port 3000) |
| Frontend | React 19, Vite 8, TailwindCSS 4, shadcn/ui, Zustand |
| Database | SQLite (WAL mode, via `bun:sqlite`) |
| LLM Proxy | CLIProxyAPI (OpenAI-compatible, port 8317) |

---

## Quick Start (Docker)

Build and run Dana in a single container:

```bash
docker build -t dana .
docker run -d -p 3000:3000 -v dana-data:/data --name dana dana
```

Access the application at [http://localhost:3000](http://localhost:3000).

After startup, navigate to **Settings > Providers & Models** to connect your LLM providers via OAuth.

---

## Development Setup

### Prerequisites

- [Bun](https://bun.sh) >= 1.0
- CLIProxyAPI running on port 8317 (required for LLM functionality)

### Install Dependencies

```bash
cd app/frontend && bun install
cd ../backend && bun install
```

### Run Services

**Backend** (port 3000):

```bash
cd app/backend
bun run src/index.ts
```

**Frontend dev server** (port 5173, proxies API to backend):

```bash
cd app/frontend
bun run dev
```

Alternatively, use the management script to start both services at once:

```bash
./manage.sh start    # start backend + frontend
./manage.sh stop     # stop all services
./manage.sh status   # show running services
./manage.sh logs backend   # tail backend logs
```

### Running Tests

```bash
./manage.sh test       # fast unit tests (no LLM required)
./manage.sh test-llm   # LLM integration tests (requires proxy on :8317)
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Backend server port |
| `DATA_DIR` | `/data` (Docker), `./data` (local) | Directory for SQLite database and CLIProxyAPI auth data |
| `PROXY_BASE_URL` | `http://127.0.0.1:8317` | CLIProxyAPI base URL |
| `SEARXNG_URL` | `http://searxng:8080` | SearXNG base URL for web search. The default resolves **inside the Docker Compose network**; for a host-run dev backend, start SearXNG (`docker compose up -d searxng`) and set `http://localhost:8080`. If unreachable, search falls back to scraping Brave (which rate-limits quickly). |
| `MANAGEMENT_SECRET` | auto-generated (Docker) | Secret for the CLIProxyAPI management API, used to add custom providers from the UI. In Docker it's generated and persisted to `$DATA_DIR/.management-secret`. Must match `remote-management.secret-key` in the proxy config. |
| `FIRECRAWL_URL` | _(unset)_ | Optional Firecrawl/localfirecrawl base URL (e.g. `http://localhost:3002`). When set, page fetches try Firecrawl `/v1/scrape` (Playwright-rendered) first, then fall back to Jina/Readability. |

### Custom API-key providers (e.g. MiniMax)

Beyond OAuth providers, you can add any **OpenAI-compatible** (`…/v1`) or **Anthropic-compatible** (`…/anthropic`) endpoint by API key + base URL under **Settings → Providers & Models → Custom providers**. This drives the CLIProxyAPI management API (changes hot-reload, no restart).

- **Docker (bundled):** works out of the box — the management secret is generated automatically.
- **Standalone proxy (dev):** add a `remote-management` block to your CLIProxyAPI `config.yaml` and set `MANAGEMENT_SECRET` in Dana to the same value:
  ```yaml
  remote-management:
    allow-remote: true     # true for cross-container/host→container; false if backend+proxy share localhost
    secret-key: "your-secret"
  ```

> Security: the custom-provider routes are unauthenticated like the rest of Dana and the base URL you enter is fetched by the proxy. Keep Dana's port bound to loopback / trusted networks only.

---

## Architecture

### Analysis Pipeline

Each topic progresses through a 5-stage pipeline:

```
Discovery --> Enrichment --> Weight Calculation --> Forum --> Scenario Scoring
```

| Stage | Description | Key Agents |
|-------|-------------|------------|
| Discovery | Researches the topic, identifies parties and initial clues | DiscoveryAgent |
| Enrichment | Deep-dives on parties and clues: capability research, news tracking, fact checking | EnrichmentAgent, CapabilityResearcher, NewsTracker, FactChecker |
| Weight Calculation | Computes relative influence weights for each party | WeightCalculator |
| Forum | Multi-agent debate where party representatives argue scenarios | ForumOrchestrator, ForumSupervisor, RepresentativeAgent, DevilsAdvocate |
| Scenario Scoring | Scores scenarios based on forum output and evidence | ScenarioScorer |

Topics transition through statuses: `draft` -> `discovery` -> `enrichment` -> `forum` -> `expert_council` -> `complete` -> `stale`.

The pipeline supports checkpoint-based resumability -- completed stages are skipped on restart. A delta pipeline handles incremental updates when new clues arrive after initial analysis.

### Data Flow

1. User action in the frontend calls a REST endpoint on the backend.
2. Backend processes the request, reads/writes SQLite, and may trigger pipeline stages.
3. Pipeline stages call LLMs via CLIProxyAPI, use external tools (web search, HTTP fetch), and store results in SQLite.
4. Real-time updates flow back to the frontend via SSE, scoped per topic.

### Settings

- **Providers & Models** -- Connect LLM providers via OAuth and configure model routing
- **System Prompts** -- Edit 35+ Markdown prompt templates with an inline editor
- **Agents & Tools** -- Toggle and configure the 12+ agents and 10+ tools
- **Pipeline** -- Set global defaults for model configuration (cascades: global -> per-topic -> per-agent)

---

## API Documentation

When the backend is running, Swagger UI is available at [http://localhost:3000/docs](http://localhost:3000/docs).

Health check endpoint: `GET /health`

---

## License

Licensed under the GNU General Public License v3.0 — see [LICENSE](LICENSE).

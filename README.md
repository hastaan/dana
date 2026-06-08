# Dana

Dana is an AI-powered **geopolitical scenario-analysis platform**. You pose a question about
how a situation might unfold; Dana researches it from open sources, identifies the parties
involved, stages a structured multi-party debate, and produces a **probability-ranked set of
outcome scenarios** — each with the evidence behind it, a reference-class base rate, and an
objective condition that would confirm it. Later you can record what actually happened and
Dana scores how well-calibrated its forecast was.

Everything runs locally (your machine + your LLM provider). A worked demo analysis is seeded
on first run, so a fresh install already shows a complete example.

---

## Quick start

```bash
./dana install     # build the image (first time only)
./dana start       # start the app + web search in the background
```

Open **[http://localhost:3000](http://localhost:3000)**. That's the whole app — UI, API, and
LLM proxy in one container, with search alongside.

`dana` is the control CLI for the whole lifecycle:

| Command | Does |
|---------|------|
| `dana start` / `stop` / `restart` | run / stop / restart the app |
| `dana status` | show service status |
| `dana logs [service]` | follow logs |
| `dana update` | pull, rebuild, restart |
| `dana install` | build the image |
| `dana link` | symlink `dana` onto your PATH so you can run it from anywhere |

Run `./dana link` once and you can drop the `./` (just `dana start`, `dana restart`, …). See
`dana help` for everything.

> Under the hood `dana` drives **`docker compose`**, and the container is booted by
> [`entrypoint.sh`](entrypoint.sh) (starts CLIProxyAPI, then the backend). Prefer raw compose?
> `docker compose up -d` works identically.

Before your first analysis, connect a model under **Settings → Providers & Models** (next section).

---

## Using Dana

The whole workflow lives on two screens: the **Topic** page (where an analysis happens) and
**Settings**. Here is the end-to-end path.

### 1. Connect an LLM provider

Open **Settings → Providers & Models** and connect at least one model. Two ways:

- **OAuth provider** — sign in to a supported provider (Anthropic / OpenAI / Google) in the
  browser; the proxy stores the credential.
- **Custom API-key provider** — paste an **OpenAI-compatible** (`…/v1`) or **Anthropic-compatible**
  (`…/anthropic`) base URL + API key. This is how you plug in e.g. **MiniMax**. Changes
  hot-reload — no restart. (Details in [Custom API-key providers](#custom-api-key-providers).)

Under **Settings → Pipeline** you can set which model each stage uses (a global default that
cascades to every topic). If a chosen model is unavailable, Dana automatically falls back to
one that is.

### 2. Create a topic

From the dashboard, **create a topic**. Give it a clear, resolvable question and an optional
paragraph of context, for example:

> *"Will the Israel–Hezbollah ceasefire of Nov 2024 still hold in 12 months?"*

Sharper, time-bounded questions produce sharper scenarios.

### 3. Run the analysis pipeline

A topic moves through five stages. **Each stage has a review gate** so you can inspect (and
correct) the output before spending tokens on the next one — or let it run straight through.

| # | Run this | It produces | Then you… |
|---|----------|-------------|-----------|
| 1 | **Run Discovery** | the **parties** involved + initial **clues** (sourced facts) | review & **Approve** the parties |
| 2 | **Run Enrichment** | deeper per-party research → more clues, fact-checks | review the new evidence |
| 3 | **Run Forum Prep** | each party's **influence weight** + a debate **representative** persona | review weights/representatives |
| 4 | **Run Forum** | the multi-party **debate** (opening → rebuttal → closing) | read the transcript |
| 5 | **Scoring** | the **verdict** — ranked outcome scenarios | read & resolve later |

Prefer one click? **Continue Analysis** runs the remaining stages back-to-back, and a full
run takes a topic from a blank question all the way to a verdict. The pipeline is
**resumable** — completed stages are skipped if you re-run, and you can **Re-run** any single
stage to refresh it.

Progress streams live (research steps, each debate turn, the final verdict) while a stage runs.

### 4. Review parties & clues

The **Parties** panel lists each actor Dana found — its type, agenda, and computed influence
weight. The **Clues** panel is the evidence base: each clue is a sourced fact with a
credibility score, relevance, and links to the originating articles. You can edit, add, or
remove either — your changes feed the later stages, so this is where your judgment shapes the
analysis.

### 5. Watch the forum debate

Open the **Forum** tab. Representatives argue **in character** for their party across three
rounds — opening statements, rebuttals (challenging each other by name), and closings where
each endorses the outcome that best serves it. Every claim cites the clue it rests on. A
synthesized **debate summary** captures the fault lines and where parties clashed or conceded.
This is what makes the scoring adversarial rather than a single model's guess.

### 6. Read the verdict

The verdict is a ranked list of **mutually-exclusive outcome scenarios** whose probabilities
sum to 100%. For each scenario you get:

- a **probability** and confidence level,
- a **base rate** — how often outcomes of this kind happen historically — and why this case
  deviates from it,
- an objective **resolution criterion** + date (the checkable condition that confirms it),
- the **key drivers** and **indicators to watch**, and the evidence chain.

Correlated sources don't inflate confidence: clues from the same primary outlet are treated
as one piece of evidence (evidence-independence de-duplication).

### 7. Resolve outcomes & track calibration

When the real outcome becomes known, **resolve** the topic against the scenario that actually
happened. Dana computes a **Brier score** and **log score** for that forecast, and the
**Calibration** page aggregates these across all resolved topics into a reliability curve —
your running track record of how well the predicted probabilities matched reality. This is
the feedback loop that makes the tool honest over time.

### 8. Steer the analysis (optional)

The **Steering** panel (per-topic, with a global default in Settings) lets you inject
*analyst guidance* — how to frame the question, what to prioritize in research, how to weigh
evidence, what the debate should stress-test (e.g. to resist a known propaganda line). Steering
guides **method, not the conclusion**: agents defer to contradicting evidence and never
fabricate to satisfy it, and the active guidance is recorded on the verdict for auditability.

---

## Settings

| Section | What you configure |
|---------|--------------------|
| **Providers & Models** | Connect OAuth or custom API-key providers; route models per stage |
| **System Prompts** | Edit the agents' prompt templates inline |
| **Agents & Tools** | Toggle and configure the agents (researchers, fact-checkers, representatives, scorer) and tools (web search, fetch) |
| **Pipeline** | Global model defaults + analysis controls (iteration budgets, debate length, etc.) |
| **Steering** | Global operator guidance applied to every topic unless overridden |

---

## Configuration

Set via environment variables (Docker Compose reads them from your shell / `.env`):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | App/API port |
| `DATA_DIR` | `/data` (Docker), `./data` (local) | SQLite database + CLIProxyAPI auth data |
| `PROXY_BASE_URL` | `http://127.0.0.1:8317` | CLIProxyAPI base URL |
| `SEARXNG_URL` | `http://searxng:8080` | Web-search backend. Default resolves **inside the Compose network**; for a host-run dev backend, run `docker compose up -d searxng` and set `http://localhost:8080`. If unreachable, search falls back to scraping Brave (rate-limits quickly). |
| `MANAGEMENT_SECRET` | auto-generated (Docker) | Secret for the CLIProxyAPI management API (adding custom providers). In Docker it's generated and persisted to `$DATA_DIR/.management-secret`. Must match `remote-management.secret-key` in the proxy config. |
| `FIRECRAWL_URL` | _(unset)_ | Optional Firecrawl/localfirecrawl base URL (e.g. `http://localhost:3002`). When set, page fetches try Firecrawl (Playwright-rendered, unlocks JS-heavy/paywalled pages) first, then fall back to Jina/Readability. |

### Custom API-key providers

Beyond OAuth, add any **OpenAI-compatible** (`…/v1`) or **Anthropic-compatible** (`…/anthropic`)
endpoint by base URL + API key under **Settings → Providers & Models → Custom providers**.
This drives the CLIProxyAPI management API (changes hot-reload, no restart).

- **Docker (bundled):** works out of the box — the management secret is generated automatically.
- **Standalone proxy (dev):** add a `remote-management` block to your CLIProxyAPI `config.yaml`
  and set `MANAGEMENT_SECRET` in Dana to the same value:
  ```yaml
  remote-management:
    allow-remote: true     # true for cross-container / host→container; false if backend+proxy share localhost
    secret-key: "your-secret"
  ```

> **Security:** Dana's routes are unauthenticated and the base URL you enter is fetched by the
> proxy. Keep Dana's port bound to loopback / trusted networks only.

---

## Pipeline reference

```
Discovery → Enrichment → Forum Prep (weights) → Forum (debate) → Scenario Scoring
```

Topic status advances through the review gates:
`draft → discovery → review_parties → enrichment → review_enrichment → forum_prep →
review_forum_prep → forum → review_forum → expert_council → complete` (→ `stale` when new
clues arrive after a verdict; a delta pipeline refreshes it).

| Stage | Does | Key agents |
|-------|------|------------|
| Discovery | Researches the topic; identifies parties + initial clues | DiscoveryAgent |
| Enrichment | Deeper per-party research, capability tracking, fact-checking | EnrichmentAgent, FactChecker |
| Forum Prep | Computes party influence weights; generates representatives | WeightCalculator |
| Forum | Multi-party debate over candidate outcomes | ForumOrchestrator, RepresentativeAgent |
| Scoring | Ranks scenarios with probabilities, base rates, resolution criteria | ScenarioScorer |

Real-time updates stream to the UI via Server-Sent Events, scoped per topic.

---

## Tech stack

| Layer | Technology |
|-------|------------|
| Backend | Bun + Elysia (port 3000) |
| Frontend | React 19, Vite, TailwindCSS 4, shadcn/ui, Zustand |
| Database | SQLite (WAL mode) |
| LLM proxy | CLIProxyAPI (OpenAI-compatible, port 8317) |
| Web search | SearXNG (port 8080) |

There is also a **Python + DSPy (STORM-powered) backend** in [`server-py/`](server-py/) — a
clean reimplementation of the same pipeline and REST/SSE contract. See its
[README](server-py/README.md) to run it instead of (or alongside) the TypeScript backend.

---

## Development

```bash
./dana dev        # backend (:3000) + frontend dev server (:5173)
```

`dana dev` installs deps, brings up SearXNG, and runs both servers with hot-reload (needs
[Bun](https://bun.sh) and a CLIProxyAPI on `:8317`). Use **[http://localhost:5173](http://localhost:5173)**
during development — the dev server proxies `/api` to the backend. Swagger UI:
**[http://localhost:3000/docs](http://localhost:3000/docs)**. Health check: `GET /health`.

---

## License

GNU General Public License v3.0 — see [LICENSE](LICENSE).

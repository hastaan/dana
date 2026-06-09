// Internet-lookup route — a NATIVE three-tier research facade over HTTP, mirroring the
// server-py contract at POST /api/research/lookup but implemented entirely on the TS/Bun
// stack (webSearch → httpFetch → chatCompletionText). No dependency on the Python backend.
//
//   quick        → ranked SearXNG hits, NO LLM (results[] + sources[]).
//   deep_lookup  → search → fetch top 2-3 → ONE grounded, cited synthesis ({ answer, ... }).
//   deep_search  → ~3 bounded angles → fetch (capped) → ONE markdown briefing ({ content, ... }).
//
// Everything is deliberately bounded so it never hammers SearXNG: quick ≤1 search,
// deep_lookup ≤3 searches (raw query + keyword sub-queries), deep_search ≤3 searches.
import { Elysia, t } from "elysia"
import { webSearch, type SearchResult } from "../tools/external/webSearch"
import { httpFetch } from "../tools/external/httpFetch"
import { chatCompletionText } from "../llm/proxyClient"
import { dbGetDefaultModels } from "../db/queries/settings"
import { log } from "../utils/logger"

type Level = "quick" | "deep_lookup" | "deep_search"
type Breadth = "clue" | "topic" | "article"

interface Source {
  title: string
  url: string
}

// SSE-style trace events emitted by the deep tiers (⇄ server-py research/internet.py emit dicts).
// Verbatim shapes so the py backend, ts backend, and frontend all match exactly.
type LookupEvent =
  | { type: "think"; icon: string; label: string; detail?: string }
  | { type: "progress"; stage: string; pct: number; msg: string }

type OnEvent = (ev: LookupEvent) => void

// Silent default so the existing POST callers (no callback) are unaffected.
const noopEmit: OnEvent = () => {}

// Per-source fetched-content cap, so synthesis prompts stay bounded.
const MAX_CONTENT_CHARS = 4000
// deep_search: hard cap on total page fetches across all angles, so it never floods.
const DEEP_SEARCH_MAX_FETCHES = 6

// Resolve a model for synthesis. Reuse the configured defaults (settings.default_models);
// the proxyClient already substitutes an available model when the requested one is "off".
function synthesisModel(): string {
  const defaults = dbGetDefaultModels()
  return defaults.enrichment || defaults.data_gathering || defaults.verdict || "claude-sonnet-4-6"
}

function subQueryModel(): string {
  const defaults = dbGetDefaultModels()
  return defaults.data_gathering || defaults.extraction || defaults.enrichment || "claude-haiku-4-5-20251001"
}

function toSources(hits: SearchResult[]): Source[] {
  return hits.map(h => ({ title: h.title, url: h.url }))
}

// Skip platforms that reliably fail extraction (login walls, JS-only feeds).
function isFetchable(url: string): boolean {
  const skip = ["x.com", "twitter.com", "instagram.com", "facebook.com", "truthsocial.com", "t.me"]
  try {
    return !skip.some(s => new URL(url).hostname.includes(s))
  } catch { return false }
}

// Fetch up to `limit` of the given hits (in order), tolerant of per-URL failures: a failed
// fetch falls back to the search snippet so a single dead link never starves synthesis.
async function fetchTop(
  hits: SearchResult[],
  limit: number,
): Promise<{ blocks: string[]; sources: Source[] }> {
  const blocks: string[] = []
  const sources: Source[] = []

  for (const hit of hits) {
    if (sources.length >= limit) break
    if (!isFetchable(hit.url)) {
      if (hit.snippet) {
        blocks.push(`[${hit.title}] (${hit.url})\n${hit.snippet}`)
        sources.push({ title: hit.title, url: hit.url })
      }
      continue
    }
    try {
      const fetched = await httpFetch(hit.url)
      blocks.push(`[${fetched.title}] (${hit.url})\n${fetched.raw_content.slice(0, MAX_CONTENT_CHARS)}`)
      sources.push({ title: fetched.title || hit.title, url: hit.url })
    } catch (err) {
      log.warn("TOOL", `research fetch failed for ${hit.url}: ${err instanceof Error ? err.message : String(err)}`)
      if (hit.snippet) {
        blocks.push(`[${hit.title}] (${hit.url})\n${hit.snippet}`)
        sources.push({ title: hit.title, url: hit.url })
      }
    }
  }

  return { blocks, sources }
}

// ── quick ──────────────────────────────────────────────────────────────────────
async function quick(query: string, topK: number, language?: string) {
  const hits = await webSearch(query, topK, undefined, language)
  return {
    status: "success" as const,
    level: "quick" as const,
    query,
    results: hits.map(h => ({ title: h.title, url: h.url, snippet: h.snippet })),
    sources: toSources(hits),
    source_urls: hits.map(h => h.url),
    source_count: hits.length,
  }
}

// ── deep_lookup ──────────────────────────────────────────────────────────────────
async function deepLookup(query: string, topK: number, language?: string, onEvent: OnEvent = noopEmit) {
  onEvent({ type: "progress", stage: "deep_lookup", pct: 0.1, msg: `Looking up: ${query.slice(0, 80)}` })
  onEvent({ type: "think", icon: "🔎", label: "Deep lookup", detail: query.slice(0, 100) })
  // Search the raw query AND keyword sub-queries, then aggregate: the raw query guarantees we
  // never do worse than a direct search, while keyword sub-queries (buildSubQueries) add
  // coverage for natural-language questions (a verbatim "what caused…" can match thesaurus
  // pages). De-duped; ≤3 searches total.
  const subs = [...new Set([query, ...(await buildSubQueries(query, 2))])].slice(0, 3)
  for (const sub of subs) {
    if (sub !== query) onEvent({ type: "think", icon: "❓", label: "Sub-question", detail: sub.slice(0, 100) })
  }
  const seen = new Set<string>()
  const hits: SearchResult[] = []
  for (const sub of subs) {
    for (const h of await webSearch(sub, topK, undefined, language)) {
      if (!seen.has(h.url)) { seen.add(h.url); hits.push(h) }
    }
    if (hits.length >= topK) break
  }
  if (hits.length === 0) {
    // No evidence → do NOT fabricate.
    return {
      status: "success" as const,
      level: "deep_lookup" as const,
      query,
      answer: "INSUFFICIENT_EVIDENCE",
      sources: [] as Source[],
      source_urls: [] as string[],
      source_count: 0,
      context: "",
    }
  }

  const { blocks, sources } = await fetchTop(hits, 3)
  const context = blocks.join("\n\n---\n\n")
  if (!context.trim()) {
    return {
      status: "success" as const,
      level: "deep_lookup" as const,
      query,
      answer: "INSUFFICIENT_EVIDENCE",
      sources,
      source_urls: sources.map(s => s.url),
      source_count: sources.length,
      context: "",
    }
  }

  const answer = await chatCompletionText({
    model: synthesisModel(),
    temperature: 0.2,
    max_tokens: 1200,
    messages: [
      {
        role: "system",
        content:
          "You answer a single question using ONLY the provided sources. Ground every claim " +
          "in the sources and cite them inline as [n] matching the numbered SOURCES list. " +
          "Do not use outside knowledge and never invent facts. If the sources do not contain " +
          "enough information to answer, reply with exactly INSUFFICIENT_EVIDENCE.",
      },
      {
        role: "user",
        content:
          `QUESTION: ${query}\n\n` +
          `SOURCES:\n${sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join("\n")}\n\n` +
          `CONTENT:\n${context}`,
      },
    ],
  })

  onEvent({ type: "progress", stage: "deep_lookup", pct: 1.0, msg: `Lookup complete — ${sources.length} sources` })
  return {
    status: "success" as const,
    level: "deep_lookup" as const,
    query,
    answer: answer.trim(),
    sources,
    source_urls: sources.map(s => s.url),
    source_count: sources.length,
    context,
  }
}

// Generate ~3 distinct sub-queries. One small LLM call; falls back to simple heuristics
// if the model is unavailable or returns nothing parseable.
async function buildSubQueries(query: string, max: number): Promise<string[]> {
  const heuristic = [query, `${query} latest developments`, `${query} analysis background`].slice(0, max)
  try {
    const raw = await chatCompletionText({
      model: subQueryModel(),
      temperature: 0.3,
      max_tokens: 200,
      messages: [
        {
          role: "system",
          content:
            "Break the subject into distinct, non-overlapping web-search queries covering " +
            "different angles (actors, timeline, causes, consequences, etc.). Return ONLY a " +
            "JSON array of short query strings.",
        },
        { role: "user", content: `SUBJECT: ${query}\nReturn ${max} queries.` },
      ],
    })
    const match = raw.match(/\[[\s\S]*\]/)
    if (match) {
      const parsed = JSON.parse(match[0]) as unknown
      if (Array.isArray(parsed)) {
        const queries = parsed
          .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
          .map(q => q.trim())
          .slice(0, max)
        if (queries.length > 0) return queries
      }
    }
  } catch (err) {
    log.warn("TOOL", `research sub-query generation failed, using heuristics: ${err instanceof Error ? err.message : String(err)}`)
  }
  return heuristic
}

// ── deep_search ──────────────────────────────────────────────────────────────────
async function deepSearch(query: string, breadth: Breadth, topK: number, maxSubQuestions: number, language?: string, onEvent: OnEvent = noopEmit) {
  onEvent({ type: "progress", stage: "deep_search", pct: 0.05, msg: `Researching: ${query.slice(0, 80)}` })
  // Bounded fan-out: ≤3 sub-queries, ≤1 search each, total fetches capped.
  const nAngles = Math.min(maxSubQuestions, 3)
  const subQueries = await buildSubQueries(query, nAngles)
  onEvent({ type: "think", icon: "🧭", label: `${subQueries.length} research angles`, detail: subQueries.join(" · ").slice(0, 120) })

  const sources: Source[] = []
  const srcIndex = new Map<string, number>()
  const blocks: string[] = []
  let remainingFetches = DEEP_SEARCH_MAX_FETCHES
  const perAngleFetch = Math.max(1, Math.floor(DEEP_SEARCH_MAX_FETCHES / Math.max(1, subQueries.length)))

  let angleIdx = 0
  for (const sub of subQueries) {
    if (remainingFetches <= 0) break
    onEvent({ type: "progress", stage: "deep_search", pct: 0.1 + (0.8 * angleIdx) / Math.max(1, subQueries.length), msg: `Angle ${angleIdx + 1}/${subQueries.length}` })
    onEvent({ type: "think", icon: "🔭", label: "Research angle", detail: sub.slice(0, 100) })
    angleIdx++
    const hits = await webSearch(sub, topK, undefined, language)
    if (hits.length === 0) continue

    const limit = Math.min(perAngleFetch, remainingFetches)
    const { blocks: angleBlocks, sources: angleSources } = await fetchTop(hits, limit)
    remainingFetches -= angleSources.length

    // Stitch findings into a numbered, citation-ready corpus (de-duped by URL).
    const angleParts: string[] = []
    for (let i = 0; i < angleSources.length; i++) {
      const src = angleSources[i]
      let n = srcIndex.get(src.url)
      if (n === undefined) {
        n = sources.length + 1
        srcIndex.set(src.url, n)
        sources.push(src)
      }
      angleParts.push(`[${n}] ${angleBlocks[i]}`)
    }
    if (angleParts.length > 0) {
      blocks.push(`### Angle: ${sub}\n${angleParts.join("\n\n")}`)
    }
  }

  if (sources.length === 0) {
    return {
      status: "success" as const,
      level: "deep_search" as const,
      breadth,
      query,
      content: "INSUFFICIENT_EVIDENCE",
      sources: [] as Source[],
      source_urls: [] as string[],
      source_count: 0,
    }
  }

  const findings = blocks.join("\n\n---\n\n").slice(0, 14000)
  const sourceList = sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join("\n")

  onEvent({ type: "progress", stage: "deep_search", pct: 0.95, msg: "Synthesizing briefing…" })
  const content = await chatCompletionText({
    model: synthesisModel(),
    temperature: 0.3,
    max_tokens: 2500,
    messages: [
      {
        role: "system",
        content:
          "Synthesize the findings into a well-structured briefing in markdown. Cite sources " +
          "inline as [n] matching the numbered SOURCES list. Ground every claim in the findings; " +
          "never invent. Note disagreements between sources rather than averaging them away. " +
          "If the findings are too thin to support a briefing, reply with exactly INSUFFICIENT_EVIDENCE.",
      },
      {
        role: "user",
        content: `SUBJECT: ${query}\n\nSOURCES:\n${sourceList}\n\nFINDINGS:\n${findings}`,
      },
    ],
  })

  onEvent({ type: "progress", stage: "deep_search", pct: 1.0, msg: `Briefing complete — ${sources.length} sources` })
  return {
    status: "success" as const,
    level: "deep_search" as const,
    breadth,
    query,
    content: content.trim(),
    sources,
    source_urls: sources.map(s => s.url),
    source_count: sources.length,
  }
}

export const researchRouter = new Elysia()
  .post("/api/research/lookup", async ({ body, set }) => {
    const query = body.query.trim()
    if (!query) {
      set.status = 400
      return { status: "error", level: body.level ?? "deep_lookup", query: body.query, message: "query is required", sources: [], source_urls: [] }
    }

    const level: Level = body.level ?? "deep_lookup"
    const breadth: Breadth = body.breadth ?? "topic"

    try {
      if (level === "quick") {
        return await quick(query, body.top_k ?? 8, body.language)
      }
      if (level === "deep_search") {
        return await deepSearch(query, breadth, body.top_k ?? 5, body.max_sub_questions ?? 3, body.language)
      }
      // default: deep_lookup
      return await deepLookup(query, body.top_k ?? 5, body.language)
    } catch (err) {
      log.error("TOOL", `research lookup (${level}) failed for "${query.slice(0, 80)}"`, err)
      set.status = 500
      return {
        status: "error",
        level,
        query,
        message: err instanceof Error ? err.message : String(err),
        sources: [],
        source_urls: [],
      }
    }
  }, {
    body: t.Object({
      query: t.String(),
      level: t.Optional(t.Union([t.Literal("quick"), t.Literal("deep_lookup"), t.Literal("deep_search")])),
      breadth: t.Optional(t.Union([t.Literal("clue"), t.Literal("topic"), t.Literal("article")])),
      top_k: t.Optional(t.Number()),
      max_sub_questions: t.Optional(t.Number()),
      language: t.Optional(t.String()),
    }),
  })
  // SSE streaming for the deep tiers (⇄ server-py GET /api/research/lookup/stream). Emits the
  // tier's live think/progress trace events verbatim, then exactly one terminal event
  // {"type":"result","result": <LookupResponse>}, then closes. The "quick" tier does NOT stream
  // (stays a plain POST); a quick request here is upgraded to deep_lookup so the stream is useful.
  .get("/api/research/lookup/stream", ({ query: q, set }) => {
    const query = (q.query ?? "").trim()
    const level: Level = q.level === "deep_search" ? "deep_search" : "deep_lookup"
    const breadth: Breadth = q.breadth ?? "topic"
    const topK = q.top_k ? Number(q.top_k) : undefined
    const maxSubQuestions = q.max_sub_questions ? Number(q.max_sub_questions) : undefined
    const language = q.language

    set.headers["Content-Type"] = "text/event-stream"
    set.headers["Cache-Control"] = "no-cache"
    set.headers["Connection"] = "keep-alive"
    set.headers["X-Accel-Buffering"] = "no"

    const stream = new ReadableStream({
      start(controller) {
        const send = (ev: unknown) => {
          try {
            controller.enqueue(`data: ${JSON.stringify(ev)}\n\n`)
          } catch {
            // client disconnected
          }
        }
        const onEvent: OnEvent = ev => send(ev)

        const run = async () => {
          if (!query) {
            send({ type: "result", result: { status: "error", level, query: q.query ?? "", message: "query is required", sources: [], source_urls: [] } })
            return
          }
          try {
            const result =
              level === "deep_search"
                ? await deepSearch(query, breadth, topK ?? 5, maxSubQuestions ?? 3, language, onEvent)
                : await deepLookup(query, topK ?? 5, language, onEvent)
            send({ type: "result", result })
          } catch (err) {
            log.error("TOOL", `research lookup stream (${level}) failed for "${query.slice(0, 80)}"`, err)
            send({
              type: "result",
              result: {
                status: "error",
                level,
                query,
                message: err instanceof Error ? err.message : String(err),
                sources: [],
                source_urls: [],
              },
            })
          }
        }

        run().finally(() => {
          try { controller.close() } catch { /* already closed */ }
        })
      },
    })

    return new Response(stream, { headers: set.headers as Record<string, string> })
  }, {
    query: t.Object({
      query: t.String(),
      level: t.Optional(t.Union([t.Literal("quick"), t.Literal("deep_lookup"), t.Literal("deep_search")])),
      breadth: t.Optional(t.Union([t.Literal("clue"), t.Literal("topic"), t.Literal("article")])),
      top_k: t.Optional(t.Union([t.Number(), t.String()])),
      max_sub_questions: t.Optional(t.Union([t.Number(), t.String()])),
      language: t.Optional(t.String()),
      token: t.Optional(t.String()),
    }),
  })

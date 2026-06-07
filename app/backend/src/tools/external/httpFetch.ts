import { parseHTML } from "linkedom"
import { Readability } from "@mozilla/readability"
import TurndownService from "turndown"

const FETCH_TIMEOUT_MS = 15_000
const FIRECRAWL_TIMEOUT_MS = 45_000  // Playwright rendering can be slow
const JINA_READER_URL = "https://r.jina.ai/"

const PAYWALLED_DOMAINS = new Set([
  "reuters.com", "wsj.com", "ft.com", "bloomberg.com",
  "nytimes.com", "washingtonpost.com", "politico.com",
  "theathletic.com", "economist.com", "foreignpolicy.com",
  "thetimes.co.uk", "telegraph.co.uk",
])

function isPaywalled(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "")
    return PAYWALLED_DOMAINS.has(host)
  } catch { return false }
}

export interface FetchResult {
  url: string
  title: string
  raw_content: string
  fetched_at: string
  cached: boolean
}

export async function httpFetch(url: string): Promise<FetchResult> {
  const firecrawlBase = process.env.FIRECRAWL_URL?.trim()
  const errors: string[] = []

  // 1. Firecrawl (Playwright-rendered) — best at JS-heavy/anti-bot/paywalled sites.
  //    Only attempted when FIRECRAWL_URL is configured; failures fall through.
  if (firecrawlBase) {
    try {
      return { ...(await fetchWithFirecrawl(firecrawlBase, url)), cached: false }
    } catch (e) {
      errors.push(`Firecrawl: ${getErrorMessage(e)}`)
    }
  }

  // 2. Paywalled domains: Jina/Readability generally can't extract these, so don't
  //    waste time or return junk — Firecrawl was their only real shot.
  if (isPaywalled(url)) {
    throw new Error(
      `httpFetch failed for paywalled domain ${url}` +
        (errors.length ? ` (${errors.join("; ")})` : " — no FIRECRAWL_URL configured to render it"),
    )
  }

  // 3. Jina Reader (hosted) → 4. Readability (local) fallbacks.
  try {
    return { ...(await fetchWithJina(url)), cached: false }
  } catch (jinaError) {
    errors.push(`Jina: ${getErrorMessage(jinaError)}`)
    try {
      return { ...(await fetchWithReadability(url)), cached: false }
    } catch (fallbackError) {
      errors.push(`Readability: ${getErrorMessage(fallbackError)}`)
      throw new Error(`httpFetch failed: ${errors.join("; ")}`)
    }
  }
}

// Firecrawl-compatible scrape (works with localfirecrawl or any Firecrawl self-host).
async function fetchWithFirecrawl(firecrawlBase: string, url: string): Promise<Omit<FetchResult, "cached">> {
  const endpoint = `${firecrawlBase.replace(/\/+$/, "")}/v1/scrape`
  const apiKey = process.env.FIRECRAWL_API_KEY?.trim()
  const res = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
    },
    FIRECRAWL_TIMEOUT_MS,
  )

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from Firecrawl`)
  }

  const payload = (await res.json()) as FirecrawlResponse
  if (payload.success === false) {
    throw new Error(payload.error || "Firecrawl reported failure")
  }
  const data = payload.data ?? {}
  const raw_content = data.markdown?.trim()
  if (!raw_content) {
    throw new Error("Firecrawl returned empty markdown")
  }
  const title = data.metadata?.title?.trim() || data.metadata?.ogTitle?.trim() || url

  return {
    url,
    title,
    raw_content,
    fetched_at: new Date().toISOString(),
  }
}

async function fetchWithJina(url: string): Promise<Omit<FetchResult, "cached">> {
  const res = await fetchWithTimeout(`${JINA_READER_URL}${url}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; Dana/1.0)",
    },
  })

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from Jina Reader`)
  }

  const payload = await res.json() as JinaResponse
  const title = payload.data?.title?.trim()
  const raw_content = payload.data?.content?.trim()

  if (!title || !raw_content) {
    throw new Error("Jina Reader response missing title or content")
  }

  return {
    url,
    title,
    raw_content,
    fetched_at: new Date().toISOString(),
  }
}

async function fetchWithReadability(url: string): Promise<Omit<FetchResult, "cached">> {
  const res = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; Dana/1.0)",
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  })

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`)
  }

  const html = await res.text()
  const { document } = parseHTML(html)

  const article = new Readability(document).parse()
  const title = article?.title?.trim() || document.title?.trim()
  const contentHtml = article?.content?.trim()

  if (!title || !contentHtml) {
    throw new Error("Readability could not extract article content")
  }

  const raw_content = new TurndownService().turndown(contentHtml).trim()
  if (!raw_content) {
    throw new Error("Turndown produced empty markdown")
  }

  return {
    url,
    title,
    raw_content,
    fetched_at: new Date().toISOString(),
  }
}

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    })
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`timeout after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface JinaResponse {
  data?: {
    title?: string
    content?: string
  }
}

interface FirecrawlResponse {
  success?: boolean
  error?: string
  data?: {
    markdown?: string
    metadata?: {
      title?: string
      ogTitle?: string
    }
  }
}

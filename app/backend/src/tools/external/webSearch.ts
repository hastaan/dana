import * as cheerio from "cheerio"

export interface SearchResult {
  title: string
  url: string
  snippet: string
  date?: string  // ISO date string, extracted from snippet text or URL path when detectable
}

export async function webSearch(
  query: string,
  numResults: number = 5,
  dateFilter?: string,
  language?: string,
): Promise<SearchResult[]> {
  const searxngUrl = process.env.SEARXNG_URL || "http://searxng:8080"

  try {
    return await searchWithSearXNG(searxngUrl, query, numResults, dateFilter, language)
  } catch (searxngError) {
    try {
      return await searchWithBrave(query, numResults)
    } catch (braveError) {
      const primaryMessage = getErrorMessage(searxngError)
      const fallbackMessage = getErrorMessage(braveError)
      throw new Error(
        `webSearch failed: SearXNG error: ${primaryMessage}; Brave fallback error: ${fallbackMessage}`
      )
    }
  }
}

async function searchWithSearXNG(
  searxngBaseUrl: string,
  query: string,
  numResults: number,
  dateFilter?: string,
  language?: string,
): Promise<SearchResult[]> {
  // Strip site: operators — SearXNG meta-search doesn't support them reliably
  const cleanQuery = query.replace(/site:\S+/gi, "").replace(/\s{2,}/g, " ").trim()
  const url = new URL("/search", normalizeBaseUrl(searxngBaseUrl))
  url.searchParams.set("q", cleanQuery || query)
  url.searchParams.set("format", "json")
  url.searchParams.set("pageno", "1")

  const timeRange = mapDateFilterToTimeRange(dateFilter)
  if (timeRange) {
    url.searchParams.set("time_range", timeRange)
  }

  // Only pass language for non-English searches; "en" is too restrictive and drops results
  if (language && language !== "en") {
    url.searchParams.set("language", language)
  }

  const res = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; Dana/1.0; +https://dana.local)",
    },
  })

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url.origin}`)
  }

  const data = await res.json() as { results?: SearxngResult[] }
  const results = Array.isArray(data.results) ? data.results : []

  return results
    .filter(result => typeof result.url === "string" && result.url.startsWith("http"))
    .slice(0, numResults)
    .map(result => {
      const snippet = typeof result.content === "string" ? decodeHtmlEntities(result.content.trim()) : ""
      const title = typeof result.title === "string" ? decodeHtmlEntities(result.title.trim()) : ""
      const derivedDate = extractDate(result.url, snippet)
      return {
        title,
        url: result.url,
        snippet,
        date: normalizePublishedDate(result.publishedDate) ?? derivedDate,
      }
    })
}

async function searchWithBrave(query: string, numResults: number): Promise<SearchResult[]> {
  const url = new URL("https://search.brave.com/search")
  url.searchParams.set("q", query)

  const res = await fetch(url.toString(), {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
  })

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from Brave`)
  }

  const html = await res.text()
  const $ = cheerio.load(html)
  const results: SearchResult[] = []

  $("div[data-type='web']").each((_, element) => {
    if (results.length >= numResults) return false

    const link = $(element).find("a[href^='http']").first()
    const href = link.attr("href")
    if (!href?.startsWith("http")) return

    const title =
      link.find("[class*='title']").first().text().trim() ||
      link.attr("title")?.trim() ||
      link.text().trim()

    const snippet = $(element)
      .find(".generic-snippet .content, [class*='description'], [class*='snippet-content']")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim()

    if (title) {
      results.push({
        title: decodeHtmlEntities(title),
        url: href,
        snippet: decodeHtmlEntities(snippet),
        date: extractDate(href, snippet),
      })
    }
  })

  if (results.length === 0) {
    throw new Error("No Brave results parsed")
  }

  return results
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
}

function mapDateFilterToTimeRange(dateFilter?: string): "day" | "week" | "month" | "year" | undefined {
  if (!dateFilter?.startsWith("after:")) return undefined

  const isoDate = dateFilter.slice("after:".length)
  const parsed = new Date(isoDate)
  if (Number.isNaN(parsed.getTime())) return undefined

  const diffDays = Math.max(0, Math.floor((Date.now() - parsed.getTime()) / (1000 * 60 * 60 * 24)))
  if (diffDays <= 1) return "day"
  if (diffDays <= 7) return "week"
  if (diffDays <= 31) return "month"
  return "year"
}

function normalizePublishedDate(publishedDate: unknown): string | undefined {
  if (typeof publishedDate !== "string" || !publishedDate.trim()) return undefined

  const dateOnly = publishedDate.match(/\d{4}-\d{2}-\d{2}/)
  if (dateOnly) return dateOnly[0]

  const parsed = new Date(publishedDate)
  if (Number.isNaN(parsed.getTime())) return undefined
  return parsed.toISOString().slice(0, 10)
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Extract a date from the URL path or snippet text
// Covers common patterns: /2026/03/27/, /2026-03-27, "March 27, 2026", "27 Mar 2026"
export function extractDate(url: string, snippet: string): string | undefined {
  // URL path: /YYYY/MM/DD/ or /YYYY-MM-DD
  const urlDate = url.match(/[\/\-](\d{4})[\/\-](0[1-9]|1[0-2])[\/\-](0[1-9]|[12]\d|3[01])/)
  if (urlDate) return `${urlDate[1]}-${urlDate[2]}-${urlDate[3]}`

  // Snippet: "Month DD, YYYY" or "DD Month YYYY"
  const MONTHS: Record<string, string> = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  }
  const mdy = snippet.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(20\d{2})\b/i)
  if (mdy) {
    const m = MONTHS[mdy[1].slice(0, 3).toLowerCase()]
    const d = mdy[2].padStart(2, "0")
    return `${mdy[3]}-${m}-${d}`
  }
  const dmy = snippet.match(/\b(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(20\d{2})\b/i)
  if (dmy) {
    const m = MONTHS[dmy[2].slice(0, 3).toLowerCase()]
    const d = dmy[1].padStart(2, "0")
    return `${dmy[3]}-${m}-${d}`
  }

  return undefined
}

interface SearxngResult {
  url: string
  title?: string
  content?: string
  publishedDate?: string | null
}

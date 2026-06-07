import { describe, it, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test"
import { webSearch, extractDate } from "../src/tools/external/webSearch"
import { httpFetch } from "../src/tools/external/httpFetch"
import { timelineLookup } from "../src/tools/external/timelineLookup"
import { scoreResult, selectBestResults, selectRecentResults } from "../src/tools/external/searchUtils"
import { mkdir, rm, writeFile, stat } from "fs/promises"
import { join } from "path"
import { createHash } from "crypto"

const TEST_DATA_DIR = "/tmp/dana-tools-test"
const TEST_TOPIC_ID = "test-topic"

function getCacheFilePath(url: string): string {
  const hash = createHash("md5").update(url).digest("hex")
  return join(TEST_DATA_DIR, "topics", TEST_TOPIC_ID, "sources", "cache", `${hash}.json`)
}

beforeAll(async () => {
  process.env.DATA_DIR = TEST_DATA_DIR
  process.env.SEARXNG_URL = "http://localhost:8080"
  await mkdir(join(TEST_DATA_DIR, "topics", TEST_TOPIC_ID, "sources", "cache"), { recursive: true })
})

afterAll(async () => {
  process.env.SEARXNG_URL = "http://localhost:8080"
  await rm(TEST_DATA_DIR, { recursive: true, force: true })
})

beforeEach(() => {
  process.env.SEARXNG_URL = "http://localhost:8080"
  mock.restore()
})

describe("webSearch", () => {
  it("returns array of results with correct shape", async () => {
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith("http://localhost:8080/")) {
        return new Response(JSON.stringify({
          results: [
            {
              title: "Bun runtime update",
              url: "https://example.com/2026/03/27/bun-runtime",
              content: "March 27, 2026 Bun runtime update",
              publishedDate: "2026-03-27T00:00:00Z",
            },
            {
              title: "Bun release notes",
              url: "https://example.com/2026/03/26/release-notes",
              content: "Release notes for Bun runtime",
            },
            {
              title: "Bun benchmarks",
              url: "https://example.com/2026/03/25/benchmarks",
              content: "Benchmark details",
            },
          ],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }

      return originalFetch(input as RequestInfo, init)
    }) as typeof fetch

    try {
      const results = await webSearch("Bun.js runtime", 3)
      expect(Array.isArray(results)).toBe(true)
      expect(results.length).toBeGreaterThanOrEqual(1)
      expect(results.length).toBeLessThanOrEqual(3)
      for (const r of results) {
        expect(r.title.length).toBeGreaterThan(0)
        expect(typeof r.title).toBe("string")
        expect(typeof r.url).toBe("string")
        expect(r.url).toMatch(/^https?:\/\//)
        expect(typeof r.snippet).toBe("string")
        if (r.date !== undefined) {
          expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        }
      }
      console.log(`webSearch returned ${results.length} results`)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("respects numResults and returns at least one result for common queries", async () => {
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith("http://localhost:8080/")) {
        return new Response(JSON.stringify({
          results: Array.from({ length: 10 }, (_, index) => ({
            title: `Result ${index + 1}`,
            url: `https://example.com/result-${index + 1}`,
            content: `Snippet ${index + 1}`,
          })),
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }

      return originalFetch(input as RequestInfo, init)
    }) as typeof fetch

    try {
      for (const numResults of [1, 3, 8]) {
        const results = await webSearch("Bun.js runtime", numResults)
        expect(results.length).toBeGreaterThanOrEqual(1)
        expect(results.length).toBeLessThanOrEqual(numResults)
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("forwards dateFilter to SearXNG time_range", async () => {
    const originalFetch = globalThis.fetch
    const calls: string[] = []

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      calls.push(url)

      if (url.startsWith("http://localhost:8080/")) {
        return new Response(JSON.stringify({
          results: [
            {
              title: "Recent result",
              url: "https://example.com/2026/04/01/report",
              content: "April 1, 2026 event",
              publishedDate: "2026-04-01T00:00:00Z",
            },
          ],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }

      return originalFetch(input as RequestInfo, init)
    }) as typeof fetch

    try {
      const results = await webSearch("Bun.js runtime", 5, "after:2025-01-01")
      expect(results.length).toBe(1)
      expect(calls.some(url => url.includes("time_range=year"))).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("falls back to Brave when SearXNG is unreachable", async () => {
    const originalFetch = globalThis.fetch
    process.env.SEARXNG_URL = "http://127.0.0.1:65534"

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url

      if (url.startsWith("https://search.brave.com/")) {
        return new Response(
          `
          <html>
            <body>
              <div data-type="web">
                <a href="https://example.com/2026/03/27/report">
                  <div class="title search-snippet-title">Brave Result Title</div>
                </a>
                <div class="generic-snippet"><div class="content">March 27, 2026 snippet text</div></div>
              </div>
            </body>
          </html>
          `,
          {
            status: 200,
            headers: { "Content-Type": "text/html" },
          },
        )
      }

      return originalFetch(input as RequestInfo, init)
    }) as typeof fetch

    try {
      const results = await webSearch("Bun.js runtime", 3)
      expect(results).toEqual([
        {
          title: "Brave Result Title",
          url: "https://example.com/2026/03/27/report",
          snippet: "March 27, 2026 snippet text",
          date: "2026-03-27",
        },
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("returns empty array for successful responses with no results", async () => {
    const originalFetch = globalThis.fetch

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith("http://localhost:8080/")) {
        return new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as typeof fetch

    try {
      await expect(webSearch("xyzzy_nonexistent_term_12345", 5)).resolves.toEqual([])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("throws descriptive error when both engines fail", async () => {
    const originalFetch = globalThis.fetch
    process.env.SEARXNG_URL = "http://127.0.0.1:65534"

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith("https://search.brave.com/")) {
        throw new Error("Brave blocked request")
      }
      return originalFetch(input as RequestInfo, init)
    }) as typeof fetch

    try {
      await expect(webSearch("Bun.js runtime", 3)).rejects.toThrow(/SearXNG error:.*Brave fallback error:/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("extracts dates from URLs and snippets", () => {
    expect(extractDate("https://example.com/2026/03/27/story", "")).toBe("2026-03-27")
    expect(extractDate("https://example.com/news-2026-03-27", "")).toBe("2026-03-27")
    expect(extractDate("https://example.com/story", "March 27, 2026 updates")).toBe("2026-03-27")
    expect(extractDate("https://example.com/story", "27 Mar 2026 updates")).toBe("2026-03-27")
    expect(extractDate("https://example.com/story", "No date here")).toBeUndefined()
  })
})

describe("httpFetch", () => {
  it("fetches markdown content via Jina Reader with preserved shape", async () => {
    const result = await httpFetch("https://example.com", TEST_TOPIC_ID)
    expect(result.url).toBe("https://example.com")
    expect(result.title.length).toBeGreaterThan(0)
    expect(result.raw_content).toContain("[Learn more](https://iana.org/domains/example)")
    expect(result.raw_content).not.toMatch(/<[^>]+>/)
    expect(result.cached).toBe(false)
    expect(typeof result.fetched_at).toBe("string")
    console.log(`Fetched title: "${result.title}", content length: ${result.raw_content.length}`)
  })

  it("returns cached result on second call within TTL", async () => {
    const result1 = await httpFetch("https://example.com", TEST_TOPIC_ID)
    const result2 = await httpFetch("https://example.com", TEST_TOPIC_ID)
    expect(result2.cached).toBe(true)
    expect(result2.raw_content).toBe(result1.raw_content)
    console.log("Cache hit confirmed")
  })

  it("falls back to readability + turndown when Jina fails", async () => {
    const originalFetch = globalThis.fetch
    let sawJina = false

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (requestUrl.startsWith("https://r.jina.ai/")) {
        sawJina = true
        throw new Error("Jina unavailable")
      }
      if (requestUrl === "https://example.com") {
        return new Response(
          `
          <!doctype html>
          <html>
            <head><title>Example Domain</title></head>
            <body>
              <main>
                <h1>Example Domain</h1>
                <p>This domain is for use in documentation examples without needing permission.</p>
                <p><a href="https://iana.org/domains/example">Learn more</a></p>
              </main>
            </body>
          </html>
          `,
          {
            status: 200,
            headers: { "Content-Type": "text/html" },
          },
        )
      }
      return originalFetch(input as RequestInfo, init)
    }) as typeof fetch

    try {
      const result = await httpFetch("https://example.com")
      expect(sawJina).toBe(true)
      expect(result.cached).toBe(false)
      expect(result.title).toBe("Example Domain")
      expect(result.raw_content).toContain("[Learn more](https://iana.org/domains/example)")
      expect(result.raw_content).not.toMatch(/<[^>]+>/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("throws immediately for paywalled domains", async () => {
    const originalFetch = globalThis.fetch
    let fetchCalls = 0

    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetchCalls += 1
      return originalFetch(...args)
    }) as typeof fetch

    try {
      for (const url of [
        "https://www.reuters.com/world/example",
        "https://www.wsj.com/world/example",
        "https://www.ft.com/content/example",
      ]) {
        await expect(httpFetch(url, TEST_TOPIC_ID)).rejects.toThrow(/paywalled domain/)
      }
      expect(fetchCalls).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("re-fetches when cached entry is older than 48 hours", async () => {
    const targetUrl = "https://example.com"
    await httpFetch(targetUrl, TEST_TOPIC_ID)
    const cacheFilePath = getCacheFilePath(targetUrl)
    const cachePayload = await Bun.file(cacheFilePath).json() as Record<string, unknown>
    cachePayload.cached_at = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString()
    await writeFile(cacheFilePath, JSON.stringify(cachePayload, null, 2))

    const refreshed = await httpFetch(targetUrl, TEST_TOPIC_ID)
    expect(refreshed.cached).toBe(false)
    const refreshedCache = await Bun.file(cacheFilePath).json() as Record<string, unknown>
    expect(new Date(String(refreshedCache.cached_at)).getTime()).toBeGreaterThan(Date.now() - 60_000)
  })

  it("works without topicId and does not write cache files", async () => {
    const targetUrl = "https://example.com"
    const cacheFilePath = getCacheFilePath(targetUrl)
    await rm(cacheFilePath, { force: true })

    const result = await httpFetch(targetUrl)
    expect(result.cached).toBe(false)
    await expect(stat(cacheFilePath)).rejects.toThrow()
  })

  it("re-fetches when cache file is corrupted", async () => {
    const cacheDir = join(TEST_DATA_DIR, "topics", TEST_TOPIC_ID, "sources", "cache")
    await rm(cacheDir, { recursive: true, force: true })
    await mkdir(cacheDir, { recursive: true })
    const existing = await httpFetch("https://example.com", TEST_TOPIC_ID)
    const files = Array.from(new Bun.Glob("*.json").scanSync({ cwd: cacheDir }))
    expect(files.length).toBeGreaterThan(0)
    await writeFile(join(cacheDir, files[0]), "{invalid json")

    const refreshed = await httpFetch("https://example.com", TEST_TOPIC_ID)
    expect(refreshed.cached).toBe(false)
    expect(refreshed.raw_content.length).toBeGreaterThan(0)
    expect(refreshed.url).toBe(existing.url)
  })

  it("surfaces timeout errors when both Jina and fallback hang", async () => {
    const originalFetch = globalThis.fetch
    const originalSetTimeout = globalThis.setTimeout

    globalThis.setTimeout = ((handler: TimerHandler) => originalSetTimeout(handler, 10)) as typeof setTimeout
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal) {
          signal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"))
          }, { once: true })
        }
      })
    }) as typeof fetch

    try {
      await expect(httpFetch("https://example.com")).rejects.toThrow(/timeout after 15000ms/)
    } finally {
      globalThis.fetch = originalFetch
      globalThis.setTimeout = originalSetTimeout
    }
  })
})

describe("timelineLookup", () => {
  it("returns array of timeline events with correct shape", async () => {
    const webSearchModule = await import("../src/tools/external/webSearch")
    mock.module("../src/tools/external/webSearch", () => ({
      ...webSearchModule,
      webSearch: async () => [
        {
          title: "Iran protests timeline update",
          url: "https://example.com/2024/01/15/protests",
          snippet: "January 15, 2024 protests update",
          date: "2024-01-15",
        },
        {
          title: "Iran protests follow-up",
          url: "https://example.com/2024/03/20/follow-up",
          snippet: "March 20, 2024 follow-up",
          date: "2024-03-20",
        },
      ],
    }))

    const events = await timelineLookup("Iran", "protests", {
      from: "2024-01-01",
      to: "2025-01-01",
    })
    expect(Array.isArray(events)).toBe(true)
    expect(events.length).toBeGreaterThan(0)
    for (const e of events) {
      expect(typeof e.date).toBe("string")
      expect(typeof e.event).toBe("string")
      expect(typeof e.source_url).toBe("string")
      expect(typeof e.relevance).toBe("number")
    }
    console.log(`timelineLookup returned ${events.length} events`)
  })
})

describe("cross-area integration", () => {
  it("feeds webSearch URLs into httpFetch for markdown content", async () => {
    const results = await webSearch("example domain", 3)
    expect(results.length).toBeGreaterThan(0)

    const fetched = await httpFetch(results[0].url)
    expect(fetched.url).toBe(results[0].url)
    expect(fetched.raw_content.length).toBeGreaterThan(50)
    expect(fetched.raw_content).not.toMatch(/<[^>]+>/)
    console.log(`search→fetch succeeded for ${results[0].url}`)
  })
})

describe("searchUtils", () => {
  it("scores recent dated results higher and keeps recent items in selections", () => {
    const recent = {
      title: "Fresh geopolitical briefing",
      url: "https://example.com/fresh",
      snippet: "Latest regional developments and analysis",
      date: "2026-03-20",
    }
    const old = {
      title: "Older geopolitical briefing",
      url: "https://example.com/old",
      snippet: "Latest regional developments and analysis",
      date: "2024-01-15",
    }
    const undated = {
      title: "Undated backgrounder",
      url: "https://example.com/background",
      snippet: "Regional overview and context",
    }

    const recentScore = scoreResult(recent, ["geopolitical", "latest"])
    const oldScore = scoreResult(old, ["geopolitical", "latest"])
    expect(recentScore - oldScore).toBeGreaterThanOrEqual(15)

    const best = selectBestResults([old, recent, undated], ["geopolitical", "latest"], 2)
    expect(best.some(result => result.url === recent.url)).toBe(true)

    const recentOnly = selectRecentResults([old, recent, undated], ["regional"], 3, 90)
    expect(recentOnly.some(result => result.url === recent.url)).toBe(true)
    expect(recentOnly.some(result => result.url === old.url)).toBe(false)
  })
})

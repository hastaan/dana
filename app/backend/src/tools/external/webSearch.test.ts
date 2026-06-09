// Failure-tolerance tests for webSearch with a MOCKED fetch — NO network, NO LLM.
//
// Current behavior (⇄ server-py tools/web_search.py): a 200 with empty results is a VALID
// answer → returns [] (no fallback). A hard failure of SearXNG (after retries) AND Brave
// degrades to [] rather than throwing, so one bad search never aborts a research run.
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { webSearch } from "./webSearch"

const SEARX = "http://localhost:8080"

let originalFetch: typeof globalThis.fetch
let originalSetTimeout: typeof globalThis.setTimeout

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
}

beforeEach(() => {
  originalFetch = globalThis.fetch
  originalSetTimeout = globalThis.setTimeout
  process.env.SEARXNG_URL = SEARX
  // Make the retry backoff sleeps instant so the hard-failure path stays fast.
  globalThis.setTimeout = ((handler: TimerHandler) => originalSetTimeout(handler, 0)) as typeof setTimeout
})

afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.setTimeout = originalSetTimeout
})

describe("webSearch failure tolerance", () => {
  it("returns [] (not throw) for a successful 200 with no results", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = urlOf(input)
      if (url.startsWith(SEARX)) {
        return new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      throw new Error(`Unexpected fetch (test must not hit network): ${url}`)
    }) as unknown as typeof fetch

    await expect(webSearch("xyzzy_nonexistent_term_12345", 5)).resolves.toEqual([])
  })

  it("returns [] (not throw) when SearXNG and Brave both hard-fail", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = urlOf(input)
      // SearXNG: transport error on every attempt; Brave: hard failure too.
      if (url.startsWith(SEARX)) throw new Error("connection refused")
      if (url.startsWith("https://search.brave.com/")) throw new Error("Brave blocked request")
      throw new Error(`Unexpected fetch (test must not hit network): ${url}`)
    }) as unknown as typeof fetch

    await expect(webSearch("anything", 3)).resolves.toEqual([])
  })

  it("returns [] when SearXNG 5xx exhausts retries and Brave yields no parseable results", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = urlOf(input)
      if (url.startsWith(SEARX)) {
        return new Response("upstream error", { status: 503 })
      }
      if (url.startsWith("https://search.brave.com/")) {
        // 200 but no parseable result divs → searchWithBrave throws → degrade to [].
        return new Response("<html><body>no results here</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        })
      }
      throw new Error(`Unexpected fetch (test must not hit network): ${url}`)
    }) as unknown as typeof fetch

    await expect(webSearch("anything", 3)).resolves.toEqual([])
  })

  it("returns parsed results on a successful 200 (filtered through sourceFilter)", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = urlOf(input)
      if (url.startsWith(SEARX)) {
        return new Response(JSON.stringify({
          results: [
            { title: "Keep me", url: "https://bbc.com/world", content: "ok" },
            { title: "Drop me", url: "https://infowars.com/x", content: "spam" },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } })
      }
      throw new Error(`Unexpected fetch (test must not hit network): ${url}`)
    }) as unknown as typeof fetch

    const results = await webSearch("topic", 5)
    expect(results.map(r => r.url)).toEqual(["https://bbc.com/world"])
  })
})

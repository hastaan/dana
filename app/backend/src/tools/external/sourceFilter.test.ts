// Unit tests for sourceFilter (⇄ server-py rigor/sources.py). Pure logic — no network/LLM.
//
// Keeps legitimate-but-biased state/partisan media (presstv.ir, rt.com); drops only
// fabrication/hoax/SEO-spam domains (e.g. infowars.com).
import { describe, it, expect } from "bun:test"
import { isValidSource, filterSources } from "./sourceFilter"
import type { SearchResult } from "./webSearch"

const mk = (url: string): SearchResult => ({ title: "t", url, snippet: "s" })

describe("isValidSource", () => {
  it("keeps state media presstv.ir", () => {
    expect(isValidSource("https://presstv.ir/news/article")).toBe(true)
  })

  it("keeps state media rt.com", () => {
    expect(isValidSource("https://www.rt.com/news/123")).toBe(true)
  })

  it("keeps mainstream outlets", () => {
    expect(isValidSource("https://www.bbc.com/news/world")).toBe(true)
  })

  it("drops infowars.com", () => {
    expect(isValidSource("https://www.infowars.com/article")).toBe(false)
  })

  it("drops satire (theonion.com)", () => {
    expect(isValidSource("https://www.theonion.com/story")).toBe(false)
  })

  it("drops subdomains of an unreliable domain", () => {
    expect(isValidSource("https://blog.infowars.com/x")).toBe(false)
  })

  it("rejects non-http urls", () => {
    expect(isValidSource("ftp://example.com")).toBe(false)
    expect(isValidSource("not a url")).toBe(false)
  })

  it("rejects empty url", () => {
    expect(isValidSource("")).toBe(false)
  })
})

describe("filterSources", () => {
  it("drops unreliable sources and keeps order", () => {
    const results = [mk("https://presstv.ir/a"), mk("https://infowars.com/b"), mk("https://rt.com/c")]
    expect(filterSources(results).map(r => r.url)).toEqual([
      "https://presstv.ir/a",
      "https://rt.com/c",
    ])
  })

  it("drops results with empty urls", () => {
    expect(filterSources([mk(""), mk("https://huzlers.com/y")])).toEqual([])
  })
})

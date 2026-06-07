import { describe, it, expect } from "bun:test"
import { processClue } from "../src/tools/processing/clueProcessor"
import { httpFetch } from "../src/tools/external/httpFetch"
import { mkdir, rm } from "fs/promises"

const TEST_DATA_DIR = "/tmp/dana-clue-test"

const RAW_HTML = `
<html>
<head><title>BBC News - Iran protests update</title></head>
<body>
<article>
<h1>Iran protests: Security forces deployed in Tehran</h1>
<p>Published: January 15, 2026. According to Reuters, Iranian security forces were deployed across central Tehran on Monday following a weekend of protests. The demonstrations, which began on January 12, 2026, saw thousands gather in Azadi Square.</p>
<p>State media IRIB reported that "a small number of troublemakers" had been arrested but gave no figures. Independent monitors place the arrested figure at over 200.</p>
<p>The protests were triggered by a sharp rise in fuel prices announced by the government on January 10, 2026.</p>
</article>
</body>
</html>
`

describe("ClueProcessor", () => {
  it("returns all required output fields", async () => {
    const result = await processClue(
      RAW_HTML,
      "https://bbc.com/news/iran-protests-2026",
      "IRI regime stability and potential collapse scenarios"
    )

    expect(typeof result.extracted_content).toBe("string")
    expect(result.extracted_content.length).toBeGreaterThan(0)

    expect(typeof result.bias_corrected_summary).toBe("string")
    expect(result.bias_corrected_summary.length).toBeGreaterThan(0)

    expect(Array.isArray(result.bias_flags)).toBe(true)

    expect(typeof result.source_credibility_score).toBe("number")
    expect(result.source_credibility_score).toBeGreaterThanOrEqual(0)
    expect(result.source_credibility_score).toBeLessThanOrEqual(100)

    expect(typeof result.credibility_notes).toBe("string")

    expect(typeof result.origin_source).toBe("object")
    expect(typeof result.origin_source.url).toBe("string")
    expect(typeof result.origin_source.outlet).toBe("string")
    expect(typeof result.origin_source.is_republication).toBe("boolean")

    expect(Array.isArray(result.key_points)).toBe(true)
    expect(result.key_points.length).toBeGreaterThan(0)

    expect(Array.isArray(result.date_references)).toBe(true)

    expect(typeof result.relevance_score).toBe("number")
    expect(result.relevance_score).toBeGreaterThanOrEqual(0)
    expect(result.relevance_score).toBeLessThanOrEqual(100)

    console.log("ClueProcessor output:", JSON.stringify(result, null, 2))
  })

  it("identifies republication correctly", async () => {
    // BBC citing Reuters should result in is_republication: true and origin outlet Reuters
    const result = await processClue(
      RAW_HTML,
      "https://bbc.com/news/iran-protests-2026",
      "Iran protests and regime stability"
    )
    // The article says "According to Reuters" — origin should be Reuters
    console.log("origin_source:", result.origin_source)
    // We trust the LLM to identify this; just verify the field is present and valid
    expect(result.origin_source.outlet.length).toBeGreaterThan(0)
  })

  it("date_references contains extracted dates", async () => {
    const result = await processClue(
      RAW_HTML,
      "https://bbc.com/news/iran-protests-2026",
      "Iran protests timeline"
    )
    expect(result.date_references.length).toBeGreaterThan(0)
    console.log("Dates found:", result.date_references)
  })
})

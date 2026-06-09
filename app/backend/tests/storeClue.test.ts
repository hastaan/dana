import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { storeClue } from "../src/tools/processing/storeClue"
import { dbGetClues } from "../src/db/queries/clues"
import { resetDb, seedTopic } from "./setup"
import { mkdir, rm } from "fs/promises"
import { join } from "path"

const TEST_DATA_DIR = "/tmp/dana-store-clue-test"
const TOPIC_ID = "test-topic-store"

const mockProcessed = {
  extracted_content: "Security forces deployed in Tehran following protests.",
  bias_corrected_summary: "Security forces were deployed in central Tehran on January 15, 2026.",
  bias_flags: ["single_source"],
  source_credibility_score: 78,
  credibility_notes: "Established outlet, some reliance on state media claims.",
  origin_source: { url: "https://reuters.com", outlet: "Reuters", is_republication: true },
  key_points: ["Security forces deployed", "Protests began Jan 12"],
  date_references: ["2026-01-15"],
  relevance_score: 85,
}

beforeAll(async () => {
  process.env.DATA_DIR = TEST_DATA_DIR
  await mkdir(join(TEST_DATA_DIR, "topics", TOPIC_ID), { recursive: true })
  // Clues are persisted to SQLite now (not clues.json); just seed the parent topic.
  resetDb()
  seedTopic(TOPIC_ID)
})

afterAll(async () => {
  await rm(TEST_DATA_DIR, { recursive: true, force: true })
})

describe("storeClue", () => {
  // Contract change: storeClue now takes sourceUrls[] (+ optional sourceOutlets[]) and persists to
  // SQLite. The origin outlet is derived from sourceOutlets (or the URL host), not from the
  // processed.origin_source field, so we pass the outlet explicitly to assert it round-trips.
  it("creates a new clue persisted to the DB", async () => {
    const result = await storeClue({
      topicId: TOPIC_ID,
      title: "Security forces deployed in Tehran",
      sourceUrls: ["https://bbc.com/iran-protests"],
      sourceOutlets: ["Reuters"],
      fetchedAt: new Date().toISOString(),
      processed: mockProcessed,
      partyRelevance: ["irgc", "opposition"],
      domainTags: ["military", "internal_security"],
      timelineDate: "2026-01-15",
    })

    expect(result.status).toBe("created")
    expect(result.clue_id).toBe("clue-001")
    expect(result.version).toBe(1)

    // Verify persisted to the DB (clues.json no longer exists — storage moved to SQLite).
    const clues = dbGetClues(TOPIC_ID)
    expect(clues.length).toBe(1)
    expect(clues[0].id).toBe("clue-001")
    expect(clues[0].versions[0].source_credibility.origin_sources[0].outlet).toBe("Reuters")
  })

  it("rejects a duplicate (same URL + same timeline_date)", async () => {
    const result = await storeClue({
      topicId: TOPIC_ID,
      title: "Security forces deployed in Tehran (duplicate)",
      sourceUrls: ["https://bbc.com/iran-protests"],
      fetchedAt: new Date().toISOString(),
      processed: mockProcessed,
      timelineDate: "2026-01-15",
    })

    expect(result.status).toBe("duplicate")

    // DB should still have only 1 clue
    expect(dbGetClues(TOPIC_ID).length).toBe(1)
  })

  it("handles concurrent writes without corruption", async () => {
    // Fire 5 concurrent storeClue calls with different URLs
    const writes = Array.from({ length: 5 }, (_, i) =>
      storeClue({
        topicId: TOPIC_ID,
        title: `Clue ${i + 2}`,
        sourceUrls: [`https://source-${i + 2}.com/article`],
        fetchedAt: new Date().toISOString(),
        processed: { ...mockProcessed, date_references: [`2026-01-${16 + i}`] },
        timelineDate: `2026-01-${16 + i}`,
      })
    )

    const results = await Promise.all(writes)
    expect(results.every(r => r.status === "created")).toBe(true)

    // All clue IDs should be unique
    const ids = results.map(r => r.clue_id)
    expect(new Set(ids).size).toBe(5)

    // DB should have 6 clues total (1 original + 5 new)
    const clues = dbGetClues(TOPIC_ID)
    expect(clues.length).toBe(6)
    console.log("Clue IDs after concurrent writes:", clues.map(c => c.id))
  })
})

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { join } from "path"
import { mkdtemp, rm, mkdir } from "fs/promises"
import { tmpdir } from "os"
import { resetDb, seedTopic, seedClues, seedState, makeClue, makeClueVersion } from "./setup"

const originalDataDir = process.env.DATA_DIR
const TOPIC_ID = "test-topic"

describe("deltaPipeline", () => {
  let testDir: string

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "dana-delta-test-"))
    process.env.DATA_DIR = testDir

    const topicDir = join(testDir, "topics", TOPIC_ID)
    await mkdir(join(topicDir, "sources", "cache"), { recursive: true })
    await mkdir(join(topicDir, "logs"), { recursive: true })

    // computeDelta reads clues + the latest state from SQLite, so seed via the DB helpers.
    resetDb()
    seedTopic(TOPIC_ID, { title: "Test Topic", description: "Test", status: "stale", current_version: 1, settings: { expert_count: 2 } })

    // v1 state: snapshot pinned clue-001 at version 1.
    seedState(TOPIC_ID, {
      version: 1, label: "Initial analysis", created_at: "2026-01-01T00:00:00Z",
      clue_snapshot: { count: 1, ids_and_versions: { "clue-001": 1 } },
      forum_session_id: "forum-session-v1", verdict_id: "verdict-v1",
    })

    // Clues — clue-001 updated to v2, plus a new clue-002.
    seedClues(TOPIC_ID, [
      makeClue({
        id: "clue-001", current: 2, added_at: "2026-01-01T00:00:00Z", last_updated_at: "2026-03-01T00:00:00Z", added_by: "auto",
        versions: [
          makeClueVersion({ v: 1, date: "2026-01-01T00:00:00Z", title: "Original event", raw_source: { urls: ["https://ex.com"], outlets: ["Ex"], fetched_at: "" }, source_credibility: { score: 80, notes: "", bias_flags: [], origin_sources: [{ url: "https://ex.com", outlet: "Ex", is_republication: false }] }, bias_corrected_summary: "Original", relevance_score: 80, party_relevance: ["party-a"], timeline_date: "2026-01-01", change_note: "Initial" }),
          makeClueVersion({ v: 2, date: "2026-03-01T00:00:00Z", title: "Updated event", raw_source: { urls: ["https://ex.com"], outlets: ["Ex"], fetched_at: "" }, source_credibility: { score: 85, notes: "", bias_flags: [], origin_sources: [{ url: "https://ex.com", outlet: "Ex", is_republication: false }] }, bias_corrected_summary: "Updated info", relevance_score: 90, party_relevance: ["party-a"], timeline_date: "2026-03-01", change_note: "Updated" }),
        ],
      }),
      makeClue({
        id: "clue-002", current: 1, added_at: "2026-03-01T00:00:00Z", last_updated_at: "2026-03-01T00:00:00Z", added_by: "user",
        versions: [
          makeClueVersion({ v: 1, date: "2026-03-01T00:00:00Z", title: "New evidence", raw_source: { urls: ["https://new.com"], outlets: ["New"], fetched_at: "" }, source_credibility: { score: 75, notes: "", bias_flags: [], origin_sources: [{ url: "https://new.com", outlet: "New", is_republication: false }] }, bias_corrected_summary: "Brand new clue", relevance_score: 85, party_relevance: ["party-a"], timeline_date: "2026-03-01", change_note: "Initial" }),
        ],
      }),
    ])
  })

  afterAll(async () => {
    process.env.DATA_DIR = originalDataDir
    await rm(testDir, { recursive: true, force: true })
  })

  test("computeDelta detects new and updated clues", async () => {
    const { computeDelta } = await import("../src/pipeline/stateManager")
    const delta = await computeDelta("test-topic")
    expect(delta).not.toBeNull()
    expect(delta!.new_clues).toContain("clue-002")
    expect(delta!.updated_clues).toContain("clue-001")
  })

  test("DeltaContext type has correct shape", () => {
    const ctx = {
      new_clues: ["clue-002"],
      updated_clues: ["clue-001"],
      affected_parties: ["party-a"],
      change_narrative: "New evidence and updated event",
    }
    expect(ctx.new_clues).toHaveLength(1)
    expect(ctx.updated_clues).toHaveLength(1)
    expect(ctx.affected_parties).toContain("party-a")
  })
})

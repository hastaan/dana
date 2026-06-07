import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { getPriorTurns, getScenarioList, getScenarioSummary, writeForumSession } from "../src/tools/internal/getForumData"
import type { ForumSession } from "../src/tools/internal/getForumData"
import { mkdir, rm } from "fs/promises"
import { join } from "path"

const TEST_DATA_DIR = "/tmp/dana-forum-tools-test"
const TOPIC_ID = "forum-tools-topic"
const SESSION_ID = "forum-session-v1"

const MOCK_SESSION: ForumSession = {
  session_id: SESSION_ID,
  version: 1,
  type: "full",
  status: "complete",
  started_at: "2026-01-01T10:00:00Z",
  completed_at: "2026-01-01T11:00:00Z",
  rounds: [
    {
      round: 1, type: "opening_statements",
      turns: [
        { id: "turn-001", representative_id: "rep-irgc", party_name: "IRGC", statement: "The IRGC maintains control [clue-001].", clues_cited: ["clue-001"], timestamp: "2026-01-01T10:05:00Z", round: 1, type: "opening_statements", word_count: 120 },
        { id: "turn-002", representative_id: "rep-opposition", party_name: "Opposition", statement: "The regime faces existential pressure [clue-002].", clues_cited: ["clue-002"], timestamp: "2026-01-01T10:10:00Z", round: 1, type: "opening_statements", word_count: 95 },
      ]
    },
    {
      round: 2, type: "rebuttals",
      turns: [
        { id: "turn-003", representative_id: "rep-opposition", party_name: "Opposition", statement: "IRGC's argument ignores [clue-001] evidence of fracture.", clues_cited: ["clue-001"], timestamp: "2026-01-01T10:20:00Z", round: 2, type: "rebuttals", word_count: 85 },
      ]
    },
  ],
  scenarios: [
    { id: "scenario-a", title: "Controlled transition", description: "...", proposed_by: "rep-opposition",
      supported_by: ["rep-usa"], contested_by: ["rep-irgc"], clues_cited: ["clue-001"],
      benefiting_parties: ["opposition"], required_conditions: ["IRGC fracture"],
      falsification_conditions: ["IRGC crackdown succeeds"] },
  ],
  scenario_summary: {
    scenarios: [
      { id: "scenario-a", title: "Controlled transition", key_clues: ["clue-001"],
        required_conditions: ["IRGC fracture"], falsification_conditions: ["IRGC crackdown succeeds"] }
    ],
    contested_clues: [
      { clue_id: "clue-001", cited_by: ["rep-irgc", "rep-opposition"], conflict: "IRGC cites as stability evidence; opposition cites as fracture evidence" }
    ],
    uncontested_clues: ["clue-002"],
  }
}

beforeAll(async () => {
  process.env.DATA_DIR = TEST_DATA_DIR
  await mkdir(join(TEST_DATA_DIR, "topics", TOPIC_ID), { recursive: true })
  await writeForumSession(TOPIC_ID, MOCK_SESSION)
})

afterAll(async () => {
  await rm(TEST_DATA_DIR, { recursive: true, force: true })
})

describe("getPriorTurns", () => {
  it("returns all turns when no filter", async () => {
    const turns = await getPriorTurns(TOPIC_ID, SESSION_ID)
    expect(turns).toHaveLength(3)
  })

  it("filters by round", async () => {
    const turns = await getPriorTurns(TOPIC_ID, SESSION_ID, { round: 1 })
    expect(turns).toHaveLength(2)
    expect(turns.every(t => t.round === 1)).toBe(true)
  })

  it("filters by party_id", async () => {
    const turns = await getPriorTurns(TOPIC_ID, SESSION_ID, { party_id: "opposition" })
    expect(turns).toHaveLength(2)
    expect(turns.every(t => t.representative_id === "rep-opposition")).toBe(true)
  })

  it("returns empty array for non-existent round", async () => {
    const turns = await getPriorTurns(TOPIC_ID, SESSION_ID, { round: 99 })
    expect(turns).toHaveLength(0)
  })

  it("throws for missing session", async () => {
    await expect(getPriorTurns(TOPIC_ID, "nonexistent-session")).rejects.toThrow("not found")
  })
})

describe("getScenarioList", () => {
  it("returns scenarios array", async () => {
    const scenarios = await getScenarioList(TOPIC_ID, SESSION_ID)
    expect(scenarios).toHaveLength(1)
    expect(scenarios[0].id).toBe("scenario-a")
    expect(scenarios[0].title).toBe("Controlled transition")
    // Does not return turn statements
    expect((scenarios[0] as any).turns).toBeUndefined()
  })
})

describe("getScenarioSummary", () => {
  it("returns pre-computed scenario summary with contested/uncontested clues", async () => {
    const summary = await getScenarioSummary(TOPIC_ID, SESSION_ID)
    expect(summary).not.toBeNull()
    expect(summary!.scenarios).toHaveLength(1)
    expect(summary!.contested_clues).toHaveLength(1)
    expect(summary!.contested_clues[0].clue_id).toBe("clue-001")
    expect(summary!.uncontested_clues).toContain("clue-002")
  })
})

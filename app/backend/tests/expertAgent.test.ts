import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { join } from "path"
import { mkdtemp, rm, mkdir } from "fs/promises"
import { tmpdir } from "os"
import { resetDb, seedTopic } from "./setup"
import { writeForumSession } from "../src/tools/internal/getForumData"
import type { ForumSession } from "../src/tools/internal/getForumData"

const originalDataDir = process.env.DATA_DIR
const TOPIC_ID = "test-topic"

describe("ExpertAgent", () => {
  let testDir: string

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "dana-expert-test-"))
    process.env.DATA_DIR = testDir

    const topicDir = join(testDir, "topics", TOPIC_ID)
    await mkdir(join(topicDir, "sources", "cache"), { recursive: true })
    await mkdir(join(topicDir, "logs"), { recursive: true })

    // Only the "scenario summary is readable" test touches storage; it reads the forum session
    // from SQLite via getScenarioSummary, so seed the topic + a completed session through the DB.
    resetDb()
    seedTopic(TOPIC_ID, { title: "Test Topic", current_version: 1 })

    const session: ForumSession = {
      session_id: "forum-session-v1",
      version: 1,
      type: "full",
      status: "complete",
      started_at: "2026-01-01T00:00:00Z",
      completed_at: "2026-01-01T01:00:00Z",
      rounds: [],
      scenarios: [
        {
          id: "scenario-a", title: "Controlled transition",
          description: "A controlled transition occurs", proposed_by: "rep-party-a",
          supported_by: ["rep-party-b"], contested_by: [],
          clues_cited: ["clue-001"], benefiting_parties: ["party-b"],
          required_conditions: ["Elite split"], falsification_conditions: ["Unity holds"],
        },
        {
          id: "scenario-b", title: "Status quo maintained",
          description: "No change happens", proposed_by: "rep-party-a",
          supported_by: [], contested_by: ["rep-party-b"],
          clues_cited: ["clue-001"], benefiting_parties: ["party-a"],
          required_conditions: ["Strong control"], falsification_conditions: ["Major protest"],
        },
      ],
      scenario_summary: {
        scenarios: [
          { id: "scenario-a", title: "Controlled transition", key_clues: ["clue-001"], required_conditions: ["Elite split"], falsification_conditions: ["Unity holds"] },
          { id: "scenario-b", title: "Status quo maintained", key_clues: ["clue-001"], required_conditions: ["Strong control"], falsification_conditions: ["Major protest"] },
        ],
        contested_clues: [{ clue_id: "clue-001", cited_by: ["rep-party-a", "rep-party-b"], conflict: "Different interpretations" }],
        uncontested_clues: [],
      },
    }
    await writeForumSession(TOPIC_ID, session)
  })

  afterAll(async () => {
    process.env.DATA_DIR = originalDataDir
    await rm(testDir, { recursive: true, force: true })
  })

  // Removed behavior: ExpertAgent no longer exports a synchronous generateExpertPersonas() with a
  // fixed 8-domain catalogue (geopolitics, …). Personas are now produced dynamically, so these
  // two assertions no longer have a function to target.
  test.skip("generateExpertPersonas produces the right count", async () => {})

  test.skip("generateExpertPersonas caps at max available domains", async () => {})

  test("weight challenge resolution: ≥2 flaggers → accepted", () => {
    // Simulate the resolveWeightChallenges logic
    const deliberations = [
      {
        expert_id: "exp-geopolitics", expert_name: "Geo", domain: "geopolitics",
        scenario_assessments: [], weight_challenges: [
          { party_id: "party-a", dimension: "economic_control", original_score: 70, suggested_score: 45, reasoning: "...", clues_cited: ["clue-001"] },
        ],
      },
      {
        expert_id: "exp-economics", expert_name: "Econ", domain: "economics",
        scenario_assessments: [], weight_challenges: [
          { party_id: "party-a", dimension: "economic_control", original_score: 70, suggested_score: 50, reasoning: "...", clues_cited: ["clue-001"] },
        ],
      },
    ]

    // Group challenges by party_id + dimension
    const grouped = new Map<string, { flagged_by: string[]; defended_by: string[]; challenge: any }>()
    for (const d of deliberations) {
      for (const wc of d.weight_challenges) {
        const key = `${wc.party_id}::${wc.dimension}`
        if (!grouped.has(key)) grouped.set(key, { flagged_by: [], defended_by: [], challenge: wc })
        grouped.get(key)!.flagged_by.push(d.expert_id)
      }
    }

    const entry = grouped.get("party-a::economic_control")!
    expect(entry.flagged_by).toHaveLength(2)
    const accepted = entry.flagged_by.length >= 2 || (entry.flagged_by.length === 1 && entry.defended_by.length === 0)
    expect(accepted).toBe(true)
  })

  test("weight challenge resolution: 1 flagger + no defense → accepted", () => {
    const deliberations = [
      {
        expert_id: "exp-geopolitics", expert_name: "Geo", domain: "geopolitics",
        scenario_assessments: [], weight_challenges: [
          { party_id: "party-a", dimension: "military_capacity", original_score: 90, suggested_score: 70, reasoning: "...", clues_cited: ["clue-001"] },
        ],
      },
      {
        expert_id: "exp-economics", expert_name: "Econ", domain: "economics",
        scenario_assessments: [], weight_challenges: [],
      },
    ]

    const grouped = new Map<string, { flagged_by: string[]; defended_by: string[]; challenge: any }>()
    for (const d of deliberations) {
      for (const wc of d.weight_challenges) {
        const key = `${wc.party_id}::${wc.dimension}`
        if (!grouped.has(key)) grouped.set(key, { flagged_by: [], defended_by: [], challenge: wc })
        grouped.get(key)!.flagged_by.push(d.expert_id)
      }
    }

    const entry = grouped.get("party-a::military_capacity")!
    expect(entry.flagged_by).toHaveLength(1)
    expect(entry.defended_by).toHaveLength(0)
    const accepted = entry.flagged_by.length >= 2 || (entry.flagged_by.length === 1 && entry.defended_by.length === 0)
    expect(accepted).toBe(true)
  })

  test("probability normalization: values > 1.0 get scaled", () => {
    const assessments = [
      { scenario_id: "a", probability_contribution: 0.6 },
      { scenario_id: "b", probability_contribution: 0.7 },
    ]
    const sum = assessments.reduce((s, a) => s + a.probability_contribution, 0)
    expect(sum).toBeGreaterThan(1.0)

    // Normalize
    if (sum > 1.05) {
      const scale = 1.0 / sum
      for (const a of assessments) {
        a.probability_contribution = Math.round(a.probability_contribution * scale * 100) / 100
      }
    }
    const newSum = assessments.reduce((s, a) => s + a.probability_contribution, 0)
    expect(newSum).toBeLessThanOrEqual(1.01)
  })

  test("scenario summary is readable from forum session", async () => {
    const { getScenarioSummary } = await import("../src/tools/internal/getForumData")
    const summary = await getScenarioSummary("test-topic", "forum-session-v1")
    expect(summary).not.toBeNull()
    expect(summary!.scenarios).toHaveLength(2)
    expect(summary!.contested_clues).toHaveLength(1)
    expect(summary!.contested_clues[0].clue_id).toBe("clue-001")
  })
})

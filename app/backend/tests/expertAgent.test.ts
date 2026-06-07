import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { join } from "path"
import { mkdtemp, rm, mkdir } from "fs/promises"
import { tmpdir } from "os"

const originalDataDir = process.env.DATA_DIR

describe("ExpertAgent", () => {
  let testDir: string

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "dana-expert-test-"))
    process.env.DATA_DIR = testDir

    const topicDir = join(testDir, "topics", "test-topic")
    await mkdir(join(topicDir, "sources", "cache"), { recursive: true })
    await mkdir(join(topicDir, "logs"), { recursive: true })

    await Bun.write(join(topicDir, "topic.json"), JSON.stringify({
      id: "test-topic", title: "Test Topic", current_version: 1,
    }))

    await Bun.write(join(topicDir, "parties.json"), JSON.stringify([
      { id: "party-a", name: "Party A", weight: 80, weight_factors: { military_capacity: 90, economic_control: 70, information_control: 60, international_support: 40, internal_legitimacy: 50 } },
      { id: "party-b", name: "Party B", weight: 50, weight_factors: { military_capacity: 30, economic_control: 60, information_control: 50, international_support: 70, internal_legitimacy: 55 } },
    ]))

    await Bun.write(join(topicDir, "clues.json"), JSON.stringify([
      {
        id: "clue-001", current: 1, added_at: "2026-01-01T00:00:00Z", last_updated_at: "2026-01-01T00:00:00Z", added_by: "auto",
        versions: [{
          v: 1, date: "2026-01-01T00:00:00Z", title: "Test clue 1",
          raw_source: { url: "https://example.com", fetched_at: "2026-01-01T00:00:00Z" },
          source_credibility: { score: 80, notes: "good source", bias_flags: [], origin_source: { url: "https://example.com", outlet: "Example", is_republication: false } },
          bias_corrected_summary: "This is a test clue about military readiness.",
          relevance_score: 85, party_relevance: ["party-a"], domain_tags: ["military"],
          timeline_date: "2026-01-01", clue_type: "event", change_note: "Initial",
          bias_flags: [],
        }],
        status: "verified",
      },
    ]))

    await Bun.write(join(topicDir, "states.json"), JSON.stringify([
      { version: 1, forum_session_id: "forum-session-v1", verdict_id: null }
    ]))

    // Write a completed forum session with scenario_summary
    await Bun.write(join(topicDir, "forum-session-v1.json"), JSON.stringify({
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
    }))
  })

  afterAll(async () => {
    process.env.DATA_DIR = originalDataDir
    await rm(testDir, { recursive: true, force: true })
  })

  test("generateExpertPersonas produces the right count", async () => {
    const { generateExpertPersonas } = await import("../src/agents/ExpertAgent")
    const experts = generateExpertPersonas("Test Topic", 4)
    expect(experts).toHaveLength(4)
    expect(experts[0].domain).toBe("geopolitics")
    expect(experts[0].auto_generated).toBe(true)
    expect(experts[0].persona_prompt).toContain("Test Topic")
  })

  test("generateExpertPersonas caps at max available domains", async () => {
    const { generateExpertPersonas } = await import("../src/agents/ExpertAgent")
    const experts = generateExpertPersonas("Test Topic", 100)
    expect(experts.length).toBeLessThanOrEqual(8) // 8 default domains
  })

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

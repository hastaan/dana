import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { runRepresentativeAgent } from "../src/agents/RepresentativeAgent"
import { writeForumSession } from "../src/tools/internal/getForumData"
import type { ForumSession } from "../src/tools/internal/getForumData"
import { mkdir, rm } from "fs/promises"
import { join } from "path"

const TEST_DATA_DIR = "/tmp/dana-forum-agents-test"
const TOPIC_ID = "forum-agents-topic"
const SESSION_ID = "forum-session-v1"
const RUN_ID = "run-forum-001"

const MOCK_PARTIES = [
  { id: "irgc", name: "IRGC", type: "state_military", description: "Iranian Revolutionary Guard Corps, the dominant military force", weight: 80,
    weight_factors: { military_capacity: 90, economic_control: 75, information_control: 70, international_support: 40, internal_legitimacy: 35 },
    agenda: "Preserve the Islamic Republic and IRGC dominance", means: ["military force", "economic control"],
    circle: { visible: ["Basij"], shadow: ["Russian FSB"] }, stance: "defensive_active",
    vulnerabilities: ["fuel subsidy dependency", "sanctions"], auto_discovered: true, user_verified: false },
]

const MOCK_CLUES = [
  { id: "clue-001", current: 1, added_at: "", last_updated_at: "", added_by: "auto", status: "verified",
    versions: [{ v: 1, date: "", title: "IRGC commander replaced in Sistan province",
      timeline_date: "2026-01-15", party_relevance: ["irgc"], domain_tags: ["military"], relevance_score: 85,
      raw_source: { url: "https://example.com", fetched_at: "" },
      source_credibility: { score: 72, notes: "", bias_flags: [], origin_source: { url: "", outlet: "Reuters", is_republication: false } },
      bias_corrected_summary: "A senior IRGC commander was replaced in Sistan-Baluchestan province in January 2026.",
      clue_type: "event", change_note: "", key_points: [] }] },
  { id: "clue-002", current: 1, added_at: "", last_updated_at: "", added_by: "auto", status: "verified",
    versions: [{ v: 1, date: "", title: "Protests resume in Tehran following fuel price hike",
      timeline_date: "2026-01-10", party_relevance: ["opposition"], domain_tags: ["social"], relevance_score: 80,
      raw_source: { url: "https://example.com/2", fetched_at: "" },
      source_credibility: { score: 68, notes: "", bias_flags: [], origin_source: { url: "", outlet: "BBC", is_republication: false } },
      bias_corrected_summary: "Protests resumed in Tehran after fuel price increases. Thousands gathered.",
      clue_type: "event", change_note: "", key_points: [] }] },
]

const MOCK_REPRESENTATIVES = [
  { id: "rep-irgc", party_id: "irgc", persona_prompt: "You represent the IRGC. Argue for their position using evidence and logic.", speaking_weight: 80,
    speaking_budget: { opening_statement: 300, rebuttal: 200, closing: 150, minimum_floor: 150 }, auto_generated: true },
]

const MOCK_SESSION: ForumSession = {
  session_id: SESSION_ID, version: 1, type: "full", status: "running",
  started_at: new Date().toISOString(), rounds: [], scenarios: [],
}

beforeAll(async () => {
  process.env.DATA_DIR = TEST_DATA_DIR
  await mkdir(join(TEST_DATA_DIR, "topics", TOPIC_ID, "logs", `run-${RUN_ID}`), { recursive: true })
  await Bun.write(join(TEST_DATA_DIR, "topics", TOPIC_ID, "topic.json"), JSON.stringify({ current_version: 1 }))
  await Bun.write(join(TEST_DATA_DIR, "topics", TOPIC_ID, "parties.json"), JSON.stringify(MOCK_PARTIES))
  await Bun.write(join(TEST_DATA_DIR, "topics", TOPIC_ID, "clues.json"), JSON.stringify(MOCK_CLUES))
  await Bun.write(join(TEST_DATA_DIR, "topics", TOPIC_ID, "representatives.json"), JSON.stringify(MOCK_REPRESENTATIVES))
  await Bun.write(join(TEST_DATA_DIR, "topics", TOPIC_ID, "states.json"), JSON.stringify([]))
  await writeForumSession(TOPIC_ID, MOCK_SESSION)
})

afterAll(async () => {
  await rm(TEST_DATA_DIR, { recursive: true, force: true })
})

describe("RepresentativeAgent", () => {
  it("produces a turn with statement, clues_cited, and word_count within budget", async () => {
    const output = await runRepresentativeAgent({
      topicId: TOPIC_ID,
      runId: RUN_ID,
      sessionId: SESSION_ID,
      partyId: "irgc",
      personaPrompt: MOCK_REPRESENTATIVES[0].persona_prompt,
      speakingBudget: MOCK_REPRESENTATIVES[0].speaking_budget,
      round: 1,
      roundType: "opening_statements",
      model: "claude-haiku-4-5-20251001",
    })

    expect(typeof output.turn.statement).toBe("string")
    expect(output.turn.statement.length).toBeGreaterThan(50)
    expect(Array.isArray(output.turn.clues_cited)).toBe(true)
    // Should cite at least one clue
    expect(output.turn.clues_cited.length).toBeGreaterThanOrEqual(1)
    expect(output.turn.round).toBe(1)
    expect(output.turn.representative_id).toBe("rep-irgc")
    // Word count within 10% of budget (300 words)
    console.log(`Statement word count: ${output.turn.word_count}`)
    expect(output.turn.word_count).toBeGreaterThan(0)

    // Artifact written
    const artifact = await Bun.file(
      join(TEST_DATA_DIR, "topics", TOPIC_ID, "logs", `run-${RUN_ID}`, "representative_irgc_r1.json")
    ).json() as any
    expect(artifact.representative_id).toBe("rep-irgc")

    console.log("Statement preview:", output.turn.statement.slice(0, 200))
    console.log("Clues cited:", output.turn.clues_cited)
  }, 30_000)
})



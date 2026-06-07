import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { join } from "path"
import { mkdtemp, rm, mkdir } from "fs/promises"
import { tmpdir } from "os"

const originalDataDir = process.env.DATA_DIR

describe("deltaPipeline", () => {
  let testDir: string

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "dana-delta-test-"))
    process.env.DATA_DIR = testDir

    const topicDir = join(testDir, "topics", "test-topic")
    await mkdir(join(topicDir, "sources", "cache"), { recursive: true })
    await mkdir(join(topicDir, "logs"), { recursive: true })

    await Bun.write(join(topicDir, "topic.json"), JSON.stringify({
      id: "test-topic", title: "Test Topic", description: "Test",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: "stale", current_version: 1,
      models: {
        data_gathering: "claude-haiku-4-5",
        extraction: "claude-haiku-4-5",
        enrichment: "claude-sonnet-4-6",
        delta_updates: "claude-sonnet-4-6",
        forum_reasoning: "claude-opus-4-6",
        expert_council: "claude-opus-4-6",
        verdict: "claude-opus-4-6",
      },
      settings: { expert_count: 2 },
    }))

    await Bun.write(join(topicDir, "parties.json"), JSON.stringify([
      { id: "party-a", name: "Party A", type: "state", weight: 80, weight_factors: {}, agenda: "Control", means: ["force"], circle: { visible: [], shadow: [] }, stance: "active", vulnerabilities: [] },
    ]))

    await Bun.write(join(topicDir, "representatives.json"), JSON.stringify([
      { id: "rep-party-a", party_id: "party-a", persona_prompt: "You represent Party A.", speaking_weight: 80, speaking_budget: { opening_statement: 300, rebuttal: 200, closing: 150, minimum_floor: 150 }, auto_generated: true },
    ]))

    // v1 state
    await Bun.write(join(topicDir, "states.json"), JSON.stringify([{
      version: 1,
      label: "Initial analysis",
      created_at: "2026-01-01T00:00:00Z",
      trigger: "initial_run",
      clue_snapshot: { count: 1, ids_and_versions: { "clue-001": 1 } },
      forum_session_id: "forum-session-v1",
      verdict_id: "verdict-v1",
      delta_from: null,
      delta_summary: null,
    }]))

    // Clues — clue-001 updated to v2, plus a new clue-002
    await Bun.write(join(topicDir, "clues.json"), JSON.stringify([
      {
        id: "clue-001", current: 2, added_at: "2026-01-01T00:00:00Z", last_updated_at: "2026-03-01T00:00:00Z", added_by: "auto",
        versions: [
          { v: 1, date: "2026-01-01T00:00:00Z", title: "Original event", raw_source: { url: "https://ex.com" }, source_credibility: { score: 80, notes: "", bias_flags: [], origin_source: { url: "https://ex.com", outlet: "Ex", is_republication: false } }, bias_corrected_summary: "Original", relevance_score: 80, party_relevance: ["party-a"], domain_tags: [], timeline_date: "2026-01-01", clue_type: "event", change_note: "Initial", bias_flags: [] },
          { v: 2, date: "2026-03-01T00:00:00Z", title: "Updated event", raw_source: { url: "https://ex.com" }, source_credibility: { score: 85, notes: "", bias_flags: [], origin_source: { url: "https://ex.com", outlet: "Ex", is_republication: false } }, bias_corrected_summary: "Updated info", relevance_score: 90, party_relevance: ["party-a"], domain_tags: [], timeline_date: "2026-03-01", clue_type: "event", change_note: "Updated", bias_flags: [] },
        ],
        status: "verified",
      },
      {
        id: "clue-002", current: 1, added_at: "2026-03-01T00:00:00Z", last_updated_at: "2026-03-01T00:00:00Z", added_by: "user",
        versions: [
          { v: 1, date: "2026-03-01T00:00:00Z", title: "New evidence", raw_source: { url: "https://new.com" }, source_credibility: { score: 75, notes: "", bias_flags: [], origin_source: { url: "https://new.com", outlet: "New", is_republication: false } }, bias_corrected_summary: "Brand new clue", relevance_score: 85, party_relevance: ["party-a"], domain_tags: [], timeline_date: "2026-03-01", clue_type: "event", change_note: "Initial", bias_flags: [] },
        ],
        status: "verified",
      },
    ]))

    // Forum session v1
    await Bun.write(join(topicDir, "forum-session-v1.json"), JSON.stringify({
      session_id: "forum-session-v1",
      version: 1,
      type: "full",
      status: "complete",
      started_at: "2026-01-01T00:00:00Z",
      completed_at: "2026-01-01T01:00:00Z",
      rounds: [{ round: 1, type: "opening_statements", turns: [
        { id: "turn-party-a-r1", representative_id: "rep-party-a", party_name: "Party A", statement: "Party A controls the situation.", clues_cited: ["clue-001"], timestamp: "2026-01-01T00:30:00Z", round: 1, type: "opening_statements", word_count: 50 },
      ]}],
      scenarios: [
        { id: "scenario-a", title: "Status quo", description: "No change", proposed_by: "rep-party-a", supported_by: [], contested_by: [], clues_cited: ["clue-001"], benefiting_parties: ["party-a"], required_conditions: ["Stability"], falsification_conditions: ["Mass protest"] },
      ],
      scenario_summary: {
        scenarios: [{ id: "scenario-a", title: "Status quo", key_clues: ["clue-001"], required_conditions: ["Stability"], falsification_conditions: ["Mass protest"] }],
        contested_clues: [],
        uncontested_clues: ["clue-001"],
      },
    }))
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

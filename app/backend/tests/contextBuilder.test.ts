import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { buildAgentContext, estimateTokens, serializeContext } from "../src/agents/contextBuilder"
import { mkdir, rm } from "fs/promises"
import { join } from "path"

const TEST_DATA_DIR = "/tmp/dana-context-test"
const TOPIC_ID = "ctx-test-topic"

// Generate 30 mock clues to test token budget
function makeMockClues(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `clue-${String(i + 1).padStart(3, "0")}`,
    current: 1,
    added_at: "2026-01-01T00:00:00Z",
    last_updated_at: "2026-01-01T00:00:00Z",
    added_by: "auto",
    status: "verified",
    versions: [{
      v: 1, date: "2026-01-01T00:00:00Z",
      title: `Clue title number ${i + 1} about some geopolitical event`,
      timeline_date: `2026-01-${String(i + 1).padStart(2, "0")}`,
      party_relevance: ["irgc"], domain_tags: ["military"], relevance_score: 70 + i,
      raw_source: { url: `https://source${i}.com`, fetched_at: "2026-01-01T00:00:00Z" },
      source_credibility: { score: 75, notes: "", bias_flags: [], origin_source: { url: "", outlet: "", is_republication: false } },
      bias_corrected_summary: "A neutral summary of this event.", clue_type: "event", change_note: "Initial", key_points: []
    }]
  }))
}

const MOCK_PARTIES = Array.from({ length: 8 }, (_, i) => ({
  id: `party-${i}`, name: `Party Name ${i}`, weight: 50 + i * 5,
  type: "state", description: "", agenda: "", means: [], circle: { visible: [], shadow: [] },
  stance: "active", vulnerabilities: [], auto_discovered: true, user_verified: false,
  weight_factors: { military_capacity: 50, economic_control: 50, information_control: 50, international_support: 50, internal_legitimacy: 50 }
}))

beforeAll(async () => {
  process.env.DATA_DIR = TEST_DATA_DIR
  await mkdir(join(TEST_DATA_DIR, "topics", TOPIC_ID, "logs"), { recursive: true })
  await Bun.write(join(TEST_DATA_DIR, "topics", TOPIC_ID, "topic.json"), JSON.stringify({ current_version: 2 }))
  await Bun.write(join(TEST_DATA_DIR, "topics", TOPIC_ID, "clues.json"), JSON.stringify(makeMockClues(30)))
  await Bun.write(join(TEST_DATA_DIR, "topics", TOPIC_ID, "parties.json"), JSON.stringify(MOCK_PARTIES))
  await Bun.write(join(TEST_DATA_DIR, "topics", TOPIC_ID, "states.json"), JSON.stringify([]))
})

afterAll(async () => {
  await rm(TEST_DATA_DIR, { recursive: true, force: true })
})

describe("buildAgentContext", () => {
  it("returns current_version, party_index, clue_index", async () => {
    const ctx = await buildAgentContext("forum", TOPIC_ID)
    expect(ctx.current_version).toBe(2)
    expect(ctx.party_index).toHaveLength(8)
    expect(ctx.clue_index).toHaveLength(30)
  })

  it("clue_index contains only lean fields (no full clue data)", async () => {
    const ctx = await buildAgentContext("forum", TOPIC_ID)
    const clue = ctx.clue_index[0]
    expect(typeof clue.id).toBe("string")
    expect(typeof clue.title).toBe("string")
    expect(typeof clue.timeline_date).toBe("string")
    expect(Array.isArray(clue.party_relevance)).toBe(true)
    expect(typeof clue.relevance_score).toBe("number")
    expect((clue as any).bias_corrected_summary).toBeUndefined()
    expect((clue as any).versions).toBeUndefined()
  })

  it("stays well under full-clue cost for 30-clue topic", async () => {
    const ctx = await buildAgentContext("enrichment", TOPIC_ID)
    const tokens = estimateTokens(ctx)
    console.log(`Token estimate for 30-clue lean context: ${tokens}`)
    // Full clues would be ~150 tokens each × 30 = 4500+; lean index should be <2000
    expect(tokens).toBeLessThan(2000)
    // And meaningfully less than passing full clue objects
    const fullCluesCost = 30 * 150
    expect(tokens).toBeLessThan(fullCluesCost)
  })

  it("forum_summary is undefined for forum agent type", async () => {
    const ctx = await buildAgentContext("forum", TOPIC_ID)
    expect(ctx.forum_summary).toBeUndefined()
  })

  it("prior_verdict_summary is undefined for non-delta agent type", async () => {
    const ctx = await buildAgentContext("expert", TOPIC_ID)
    expect(ctx.prior_verdict_summary).toBeUndefined()
  })

  it("serializeContext produces compact string with all sections", async () => {
    const ctx = await buildAgentContext("enrichment", TOPIC_ID)
    const s = serializeContext(ctx)
    expect(s).toContain("Version: 2")
    expect(s).toContain("Parties (8)")
    expect(s).toContain("Clues (30)")
    console.log("Serialized context length:", s.length, "chars")
  })
})

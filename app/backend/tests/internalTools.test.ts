import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { getClue, getClueIndex } from "../src/tools/internal/getClue"
import { getPartyProfile, getPartyIndex } from "../src/tools/internal/getPartyProfile"
import { writeArtifact, readArtifact, artifactExists } from "../src/tools/internal/artifactStore"
import { mkdir, rm } from "fs/promises"
import { join } from "path"

const TEST_DATA_DIR = "/tmp/dana-internal-tools-test"
const TOPIC_ID = "test-internal"

const MOCK_CLUES = [
  {
    id: "clue-001", current: 2, added_at: "2026-01-01T00:00:00Z", last_updated_at: "2026-01-02T00:00:00Z",
    added_by: "auto", status: "verified",
    versions: [
      { v: 1, date: "2026-01-01T00:00:00Z", title: "Clue v1 title", timeline_date: "2026-01-01",
        party_relevance: ["irgc"], domain_tags: ["military"], relevance_score: 80,
        raw_source: { url: "https://example.com", fetched_at: "2026-01-01T00:00:00Z" },
        source_credibility: { score: 75, notes: "", bias_flags: [], origin_source: { url: "https://example.com", outlet: "Example", is_republication: false } },
        bias_corrected_summary: "Summary v1", clue_type: "event", change_note: "Initial", key_points: [] },
      { v: 2, date: "2026-01-02T00:00:00Z", title: "Clue v2 title", timeline_date: "2026-01-02",
        party_relevance: ["irgc", "opposition"], domain_tags: ["military"], relevance_score: 90,
        raw_source: { url: "https://example.com/v2", fetched_at: "2026-01-02T00:00:00Z" },
        source_credibility: { score: 80, notes: "", bias_flags: [], origin_source: { url: "https://example.com/v2", outlet: "Example", is_republication: false } },
        bias_corrected_summary: "Summary v2", clue_type: "event", change_note: "Update", key_points: [] },
    ]
  }
]

const MOCK_PARTIES = [
  { id: "irgc", name: "IRGC", type: "state_military", description: "...", weight: 87,
    weight_factors: { military_capacity: 90, economic_control: 75, information_control: 70, international_support: 40, internal_legitimacy: 35 },
    agenda: "Preserve the state", means: ["military"], circle: { visible: [], shadow: [] },
    stance: "defensive_active", vulnerabilities: ["sanctions"], auto_discovered: true, user_verified: false }
]

beforeAll(async () => {
  process.env.DATA_DIR = TEST_DATA_DIR
  await mkdir(join(TEST_DATA_DIR, "topics", TOPIC_ID, "logs"), { recursive: true })
  await Bun.write(join(TEST_DATA_DIR, "topics", TOPIC_ID, "clues.json"), JSON.stringify(MOCK_CLUES))
  await Bun.write(join(TEST_DATA_DIR, "topics", TOPIC_ID, "parties.json"), JSON.stringify(MOCK_PARTIES))
})

afterAll(async () => {
  await rm(TEST_DATA_DIR, { recursive: true, force: true })
})

describe("getClue", () => {
  it("returns current version by default", async () => {
    const v = await getClue(TOPIC_ID, "clue-001")
    expect(v.v).toBe(2)
    expect(v.title).toBe("Clue v2 title")
    expect(v.relevance_score).toBe(90)
  })

  it("returns specific version when requested", async () => {
    const v = await getClue(TOPIC_ID, "clue-001", 1)
    expect(v.v).toBe(1)
    expect(v.title).toBe("Clue v1 title")
  })

  it("throws for missing clue", async () => {
    await expect(getClue(TOPIC_ID, "clue-999")).rejects.toThrow("not found")
  })
})

describe("getClueIndex", () => {
  it("returns lean index with id, title, timeline_date, party_relevance, relevance_score", async () => {
    const index = await getClueIndex(TOPIC_ID)
    expect(index).toHaveLength(1)
    expect(index[0].id).toBe("clue-001")
    expect(index[0].title).toBe("Clue v2 title") // current version
    expect(typeof index[0].relevance_score).toBe("number")
    // Verify no full clue data leaked
    expect((index[0] as any).versions).toBeUndefined()
    expect((index[0] as any).bias_corrected_summary).toBeUndefined()
  })
})

describe("getPartyProfile", () => {
  it("returns full party profile", async () => {
    const party = await getPartyProfile(TOPIC_ID, "irgc")
    expect(party.id).toBe("irgc")
    expect(party.weight).toBe(87)
    expect(party.weight_factors.military_capacity).toBe(90)
  })

  it("throws for missing party", async () => {
    await expect(getPartyProfile(TOPIC_ID, "unknown")).rejects.toThrow("not found")
  })
})

describe("getPartyIndex", () => {
  it("returns lean index with id, name, weight only", async () => {
    const index = await getPartyIndex(TOPIC_ID)
    expect(index).toHaveLength(1)
    expect(index[0].id).toBe("irgc")
    expect(index[0].weight).toBe(87)
    expect((index[0] as any).vulnerabilities).toBeUndefined()
  })
})

describe("artifactStore", () => {
  it("writes and reads artifact", async () => {
    const data = { foo: "bar", count: 42 }
    const result = await writeArtifact(TOPIC_ID, "run-001", "test_artifact", data)
    expect(result.path).toContain("test_artifact.json")
    expect(typeof result.written_at).toBe("string")

    const read = await readArtifact<typeof data>(TOPIC_ID, "run-001", "test_artifact")
    expect(read.foo).toBe("bar")
    expect(read.count).toBe(42)
  })

  it("artifactExists returns true/false correctly", async () => {
    expect(await artifactExists(TOPIC_ID, "run-001", "test_artifact")).toBe(true)
    expect(await artifactExists(TOPIC_ID, "run-001", "nonexistent")).toBe(false)
  })

  it("throws when reading missing artifact", async () => {
    await expect(readArtifact(TOPIC_ID, "run-001", "ghost")).rejects.toThrow("not found")
  })
})

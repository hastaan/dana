import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { runDiscoveryAgent } from "../src/agents/DiscoveryAgent"
import { mkdir, rm } from "fs/promises"
import { join } from "path"

const TEST_DATA_DIR = "/tmp/dana-discovery-test"
const TOPIC_ID = "iri-collapse-test"

beforeAll(async () => {
  process.env.DATA_DIR = TEST_DATA_DIR
  await mkdir(join(TEST_DATA_DIR, "topics", TOPIC_ID, "sources", "cache"), { recursive: true })
  await mkdir(join(TEST_DATA_DIR, "topics", TOPIC_ID, "logs"), { recursive: true })
  await Bun.write(join(TEST_DATA_DIR, "topics", TOPIC_ID, "clues.json"), "[]")
  await Bun.write(join(TEST_DATA_DIR, "topics", TOPIC_ID, "parties.json"), "[]")
})

afterAll(async () => {
  await rm(TEST_DATA_DIR, { recursive: true, force: true })
})

describe("DiscoveryAgent", () => {
  it("produces ≥5 parties and ≥3 seed clues", async () => {
    const messages: string[] = []

    const output = await runDiscoveryAgent(
      TOPIC_ID,
      "IRI regime collapse and formation of a new Iranian state",
      "Analysis of potential collapse of the Islamic Republic of Iran following ongoing protests and external pressures, and what a successor state might look like.",
      "claude-haiku-4-5-20251001",
      "run-test-001",
      (msg) => {
        messages.push(msg)
        console.log("[progress]", msg)
      }
    )

    // Parties check
    expect(output.parties.length).toBeGreaterThanOrEqual(5)
    console.log(`Parties found (${output.parties.length}):`, output.parties.map(p => p.name))

    // Every party has required fields
    for (const party of output.parties) {
      expect(typeof party.id).toBe("string")
      expect(party.id.length).toBeGreaterThan(0)
      expect(typeof party.name).toBe("string")
      expect(typeof party.weight).toBe("number")
      expect(party.weight).toBeGreaterThanOrEqual(0)
      expect(party.weight).toBeLessThanOrEqual(100)
      expect(typeof party.agenda).toBe("string")
      expect(Array.isArray(party.means)).toBe(true)
      expect(Array.isArray(party.vulnerabilities)).toBe(true)
    }

    // Seed clues check
    expect(output.seed_clue_ids.length).toBeGreaterThanOrEqual(3)
    console.log(`Seed clues: ${output.seed_clue_ids.length}`, output.seed_clue_ids)

    // parties.json written to disk
    const parties = await Bun.file(join(TEST_DATA_DIR, "topics", TOPIC_ID, "parties.json")).json() as any[]
    expect(parties.length).toBe(output.parties.length)

    // artifact written
    const artifact = await Bun.file(
      join(TEST_DATA_DIR, "topics", TOPIC_ID, "logs", "run-run-test-001", "discovery_output.json")
    ).json() as any
    expect(artifact.topic_id).toBe(TOPIC_ID)
    expect(artifact.run_id).toBe("run-test-001")

    // clues.json on disk matches seed count
    const clues = await Bun.file(join(TEST_DATA_DIR, "topics", TOPIC_ID, "clues.json")).json() as any[]
    expect(clues.length).toBe(output.seed_clue_ids.length)

    // progress messages fired
    expect(messages.length).toBeGreaterThan(0)
  }, 120_000)
})

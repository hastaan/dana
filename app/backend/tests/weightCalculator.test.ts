import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { runWeightCalculator } from "../src/agents/WeightCalculator"
import { mkdir, rm } from "fs/promises"
import { join } from "path"

const TEST_DATA_DIR = "/tmp/dana-weight-test"
const TOPIC_ID = "weight-test-topic"

const MOCK_PARTIES = [
  { id: "irgc", name: "IRGC", type: "state_military", description: "Iranian Revolutionary Guard", weight: 0,
    weight_factors: { military_capacity: 0, economic_control: 0, information_control: 0, international_support: 0, internal_legitimacy: 0 },
    agenda: "Preserve the Islamic Republic", means: ["military"], circle: { visible: [], shadow: [] },
    stance: "defensive_active", vulnerabilities: ["sanctions"], auto_discovered: true, user_verified: false },
  { id: "opposition", name: "Iranian Opposition", type: "non_state", description: "Protest movements", weight: 0,
    weight_factors: { military_capacity: 0, economic_control: 0, information_control: 0, international_support: 0, internal_legitimacy: 0 },
    agenda: "Overthrow the regime", means: ["protests", "social media"], circle: { visible: [], shadow: [] },
    stance: "active", vulnerabilities: ["no military"], auto_discovered: true, user_verified: false },
  { id: "usa", name: "United States", type: "state", description: "US government", weight: 0,
    weight_factors: { military_capacity: 0, economic_control: 0, information_control: 0, international_support: 0, internal_legitimacy: 0 },
    agenda: "Prevent nuclear proliferation, promote regional stability", means: ["sanctions", "diplomacy"], circle: { visible: [], shadow: [] },
    stance: "passive", vulnerabilities: ["war fatigue"], auto_discovered: true, user_verified: false },
]

beforeAll(async () => {
  process.env.DATA_DIR = TEST_DATA_DIR
  await mkdir(join(TEST_DATA_DIR, "topics", TOPIC_ID, "logs"), { recursive: true })
  await Bun.write(join(TEST_DATA_DIR, "topics", TOPIC_ID, "topic.json"), JSON.stringify({ current_version: 0 }))
  await Bun.write(join(TEST_DATA_DIR, "topics", TOPIC_ID, "parties.json"), JSON.stringify(MOCK_PARTIES))
  await Bun.write(join(TEST_DATA_DIR, "topics", TOPIC_ID, "clues.json"), JSON.stringify([]))
  await Bun.write(join(TEST_DATA_DIR, "topics", TOPIC_ID, "states.json"), JSON.stringify([]))
  await Bun.write(join(TEST_DATA_DIR, "topics", TOPIC_ID, "representatives.json"), JSON.stringify([]))
})

afterAll(async () => {
  await rm(TEST_DATA_DIR, { recursive: true, force: true })
})

describe("WeightCalculator", () => {
  it("assigns weights and speaking budgets, writes representatives.json", async () => {
    const messages: string[] = []
    const output = await runWeightCalculator(
      TOPIC_ID,
      "IRI regime collapse",
      "claude-haiku-4-5-20251001",
      "run-weight-001",
      (msg) => { messages.push(msg); console.log("[progress]", msg) }
    )

    // Weight scores returned
    expect(output.party_weights.length).toBeGreaterThanOrEqual(3)
    for (const pw of output.party_weights) {
      expect(pw.weight).toBeGreaterThanOrEqual(0)
      expect(pw.weight).toBeLessThanOrEqual(100)
      expect(typeof pw.weight_factors.military_capacity).toBe("number")
    }

    // parties.json updated with weights
    const parties = await Bun.file(join(TEST_DATA_DIR, "topics", TOPIC_ID, "parties.json")).json() as any[]
    for (const p of parties) {
      expect(p.weight).toBeGreaterThan(0)
    }
    console.log("Party weights:", parties.map((p: any) => `${p.name}: ${p.weight}`))

    // representatives.json written with speaking budgets
    const reps = await Bun.file(join(TEST_DATA_DIR, "topics", TOPIC_ID, "representatives.json")).json() as any[]
    expect(reps.length).toBe(MOCK_PARTIES.length)

    for (const rep of reps) {
      expect(typeof rep.persona_prompt).toBe("string")
      expect(rep.persona_prompt.length).toBeGreaterThan(0)
      expect(typeof rep.speaking_budget.opening_statement).toBe("number")
      expect(rep.speaking_budget.opening_statement).toBeGreaterThanOrEqual(150) // floor
      expect(typeof rep.speaking_budget.rebuttal).toBe("number")
      expect(typeof rep.speaking_budget.closing).toBe("number")
    }
    console.log("Representatives:", reps.map((r: any) => `${r.party_id}: budget=${r.speaking_budget.opening_statement}w`))

    // Speaking budgets proportional to weights (heaviest party gets more words)
    const sortedByWeight = [...parties].sort((a: any, b: any) => b.weight - a.weight)
    const heaviest = sortedByWeight[0]
    const lightest = sortedByWeight[sortedByWeight.length - 1]
    const heaviestRep = reps.find((r: any) => r.party_id === heaviest.id)
    const lightestRep = reps.find((r: any) => r.party_id === lightest.id)
    // Heaviest should get >= lightest budget
    expect(heaviestRep.speaking_budget.opening_statement).toBeGreaterThanOrEqual(lightestRep.speaking_budget.opening_statement)

    // Artifact written
    const artifact = await Bun.file(
      join(TEST_DATA_DIR, "topics", TOPIC_ID, "logs", "run-run-weight-001", "weight_calculation.json")
    ).json() as any
    expect(artifact.topic_id).toBe(TOPIC_ID)
  }, 60_000)
})

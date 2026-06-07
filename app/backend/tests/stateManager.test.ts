import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import {
  createVersion, getLatestVersion, getAllVersions, markStale,
  computeDelta, getCurrentClueSnapshot
} from "../src/pipeline/stateManager"
import {
  writeCheckpoint, readCheckpoint, markTurnComplete, isTurnComplete, isStageComplete
} from "../src/pipeline/checkpointManager"
import { mkdir, rm } from "fs/promises"
import { join } from "path"

const TEST_DATA_DIR = "/tmp/dana-state-test"
const TOPIC_ID = "state-test-topic"

const MOCK_CLUES_V1 = [
  { id: "clue-001", current: 1, added_at: "", last_updated_at: "", added_by: "auto", status: "verified",
    versions: [{ v: 1, date: "", title: "Clue 001", timeline_date: "2026-01-01", party_relevance: ["irgc"],
      domain_tags: [], relevance_score: 80, raw_source: { url: "https://a.com", fetched_at: "" },
      source_credibility: { score: 75, notes: "", bias_flags: [], origin_source: { url: "", outlet: "", is_republication: false } },
      bias_corrected_summary: "", clue_type: "event", change_note: "", key_points: [] }] },
]

const MOCK_CLUES_V2 = [
  ...MOCK_CLUES_V1,
  { id: "clue-002", current: 1, added_at: "", last_updated_at: "", added_by: "auto", status: "verified",
    versions: [{ v: 1, date: "", title: "Clue 002", timeline_date: "2026-01-02", party_relevance: ["opposition"],
      domain_tags: [], relevance_score: 75, raw_source: { url: "https://b.com", fetched_at: "" },
      source_credibility: { score: 70, notes: "", bias_flags: [], origin_source: { url: "", outlet: "", is_republication: false } },
      bias_corrected_summary: "", clue_type: "event", change_note: "", key_points: [] }] },
]

beforeAll(async () => {
  process.env.DATA_DIR = TEST_DATA_DIR
  await mkdir(join(TEST_DATA_DIR, "topics", TOPIC_ID, "logs"), { recursive: true })
  await Bun.write(join(TEST_DATA_DIR, "topics", TOPIC_ID, "topic.json"), JSON.stringify({
    id: TOPIC_ID, status: "complete", current_version: 0, updated_at: new Date().toISOString()
  }))
  await Bun.write(join(TEST_DATA_DIR, "topics", TOPIC_ID, "clues.json"), JSON.stringify(MOCK_CLUES_V1))
  await Bun.write(join(TEST_DATA_DIR, "topics", TOPIC_ID, "states.json"), JSON.stringify([]))
})

afterAll(async () => {
  await rm(TEST_DATA_DIR, { recursive: true, force: true })
})

describe("StateManager", () => {
  it("createVersion creates v1 entry with correct clue snapshot", async () => {
    const state = await createVersion(TOPIC_ID, {
      label: "Initial analysis",
      trigger: "initial_run",
      forum_session_id: "forum-session-v1",
      verdict_id: "verdict-v1",
    })
    expect(state.version).toBe(1)
    expect(state.trigger).toBe("initial_run")
    expect(state.clue_snapshot.count).toBe(1)
    expect(state.clue_snapshot.ids_and_versions["clue-001"]).toBe(1)
    expect(state.forum_session_id).toBe("forum-session-v1")
  })

  it("getLatestVersion returns v1", async () => {
    const latest = await getLatestVersion(TOPIC_ID)
    expect(latest?.version).toBe(1)
  })

  it("topic.json current_version updated to 1 and status complete", async () => {
    const topic = await Bun.file(join(TEST_DATA_DIR, "topics", TOPIC_ID, "topic.json")).json() as any
    expect(topic.current_version).toBe(1)
    expect(topic.status).toBe("complete")
  })

  it("markStale sets topic status to stale", async () => {
    await markStale(TOPIC_ID)
    const topic = await Bun.file(join(TEST_DATA_DIR, "topics", TOPIC_ID, "topic.json")).json() as any
    expect(topic.status).toBe("stale")
  })

  it("computeDelta detects new clue after adding clue-002", async () => {
    // Simulate adding a new clue
    await Bun.write(join(TEST_DATA_DIR, "topics", TOPIC_ID, "clues.json"), JSON.stringify(MOCK_CLUES_V2))
    const delta = await computeDelta(TOPIC_ID)
    expect(delta).not.toBeNull()
    expect(delta!.new_clues).toContain("clue-002")
    expect(delta!.updated_clues).toHaveLength(0)
    expect(delta!.affected_parties).toContain("opposition")
  })

  it("createVersion v2 records correct delta", async () => {
    const delta = await computeDelta(TOPIC_ID)
    const state = await createVersion(TOPIC_ID, {
      label: "Added clue-002",
      trigger: "user_add_clue",
      delta_from: 1,
      delta_summary: delta!,
    })
    expect(state.version).toBe(2)
    expect(state.delta_from).toBe(1)
    expect(state.clue_snapshot.count).toBe(2)
  })

  it("getAllVersions returns both versions", async () => {
    const versions = await getAllVersions(TOPIC_ID)
    expect(versions).toHaveLength(2)
    expect(versions[0].version).toBe(1)
    expect(versions[1].version).toBe(2)
  })
})

describe("CheckpointManager", () => {
  const RUN_ID = "cp-test-run"

  it("writeCheckpoint creates checkpoint file", async () => {
    const cp = await writeCheckpoint(TOPIC_ID, RUN_ID, { stage: "discovery", step: 0 })
    expect(cp.run_id).toBe(RUN_ID)
    expect(cp.stage).toBe("discovery")
    expect(cp.completed_turn_ids).toHaveLength(0)
  })

  it("readCheckpoint reads back the checkpoint", async () => {
    const cp = await readCheckpoint(TOPIC_ID, RUN_ID)
    expect(cp?.stage).toBe("discovery")
  })

  it("markTurnComplete adds turn to completed list", async () => {
    await markTurnComplete(TOPIC_ID, RUN_ID, "turn-001")
    await markTurnComplete(TOPIC_ID, RUN_ID, "turn-002")
    const cp = await readCheckpoint(TOPIC_ID, RUN_ID)
    expect(cp?.completed_turn_ids).toContain("turn-001")
    expect(cp?.completed_turn_ids).toContain("turn-002")
  })

  it("isTurnComplete returns correct boolean", async () => {
    const cp = await readCheckpoint(TOPIC_ID, RUN_ID)
    expect(isTurnComplete(cp, "turn-001")).toBe(true)
    expect(isTurnComplete(cp, "turn-999")).toBe(false)
  })

  it("isStageComplete compares stage order correctly", async () => {
    const cp = await writeCheckpoint(TOPIC_ID, RUN_ID, { stage: "forum" })
    expect(isStageComplete(cp, "discovery")).toBe(true)
    expect(isStageComplete(cp, "enrichment")).toBe(true)
    expect(isStageComplete(cp, "forum")).toBe(false)
    expect(isStageComplete(cp, "expert_council")).toBe(false)
  })

  it("readCheckpoint returns null for nonexistent run", async () => {
    const cp = await readCheckpoint(TOPIC_ID, "nonexistent-run")
    expect(cp).toBeNull()
  })
})

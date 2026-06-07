import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { join } from "path"
import { mkdtemp, rm, mkdir } from "fs/promises"
import { tmpdir } from "os"

const originalDataDir = process.env.DATA_DIR

describe("pipeline route", () => {
  let testDir: string

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "dana-pipeline-test-"))
    process.env.DATA_DIR = testDir

    // Create topic directory structure
    const topicDir = join(testDir, "topics", "test-topic")
    await mkdir(join(topicDir, "sources", "cache"), { recursive: true })
    await mkdir(join(topicDir, "logs"), { recursive: true })

    const topic = {
      id: "test-topic",
      title: "Test Topic",
      description: "A test topic for pipeline tests",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: "draft",
      current_version: 0,
      models: {
        data_gathering: "claude-haiku-4-5",
        extraction: "claude-haiku-4-5",
        enrichment: "claude-sonnet-4-6",
        delta_updates: "claude-sonnet-4-6",
        forum_reasoning: "claude-opus-4-6",
        expert_council: "claude-opus-4-6",
        verdict: "claude-opus-4-6",
      },
      settings: {
        auto_discover_parties: true,
        auto_gather_clues: true,
        clue_search_depth: 3,
        forum_rounds: 3,
        expert_count: 6,
        language: "en",
      },
    }
    await Bun.write(join(topicDir, "topic.json"), JSON.stringify(topic, null, 2))
    await Bun.write(join(topicDir, "parties.json"), "[]")
    await Bun.write(join(topicDir, "clues.json"), "[]")
    await Bun.write(join(topicDir, "representatives.json"), "[]")
    await Bun.write(join(topicDir, "states.json"), "[]")
  })

  afterAll(async () => {
    process.env.DATA_DIR = originalDataDir
    await rm(testDir, { recursive: true, force: true })
  })

  test("isStageComplete works correctly", async () => {
    const { isStageComplete } = await import("../src/pipeline/checkpointManager")
    
    expect(isStageComplete(null, "discovery")).toBe(false)
    
    const cp = {
      run_id: "test",
      topic_id: "test",
      stage: "forum" as const,
      step: 0,
      completed_turn_ids: [],
      created_at: "",
      updated_at: "",
    }
    
    expect(isStageComplete(cp, "discovery")).toBe(true)
    expect(isStageComplete(cp, "enrichment")).toBe(true)
    expect(isStageComplete(cp, "weight")).toBe(true)
    expect(isStageComplete(cp, "forum")).toBe(false)
    expect(isStageComplete(cp, "expert_council")).toBe(false)
  })

  test("pipeline status route returns not running when idle", async () => {
    const { getActiveRun } = await import("../src/routes/pipeline")
    const result = getActiveRun("test-topic")
    expect(result).toBeNull()
  })

  test("checkpoint write/read round-trip works", async () => {
    const { writeCheckpoint, readCheckpoint } = await import("../src/pipeline/checkpointManager")
    
    const cp = await writeCheckpoint("test-topic", "test-run-1", {
      stage: "enrichment",
      step: 2,
    })
    
    expect(cp.stage).toBe("enrichment")
    expect(cp.step).toBe(2)
    
    const read = await readCheckpoint("test-topic", "test-run-1")
    expect(read).not.toBeNull()
    expect(read!.stage).toBe("enrichment")
    expect(read!.step).toBe(2)
  })
})

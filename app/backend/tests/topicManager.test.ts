import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { createTopic, getTopic, listTopics, updateTopic, deleteTopic } from "../src/pipeline/topicManager"
import { join } from "path"
import { rm, mkdir } from "fs/promises"

const TEST_DATA_DIR = "/tmp/dana-test-data"

// Point DATA_DIR to temp dir for tests
process.env.DATA_DIR = TEST_DATA_DIR

beforeAll(async () => {
  await mkdir(join(TEST_DATA_DIR, "topics"), { recursive: true })
})

afterAll(async () => {
  await rm(TEST_DATA_DIR, { recursive: true, force: true })
})

describe("TopicManager", () => {
  let topicId: string

  it("creates a topic and writes JSON to disk", async () => {
    const topic = await createTopic({
      title: "Test Topic",
      description: "A test topic for unit testing",
    })
    topicId = topic.id
    expect(topic.id).toBeTruthy()
    expect(topic.title).toBe("Test Topic")
    expect(topic.status).toBe("draft")
    expect(topic.current_version).toBe(0)

    // verify JSON written to disk
    const file = Bun.file(join(TEST_DATA_DIR, "topics", topic.id, "topic.json"))
    expect(await file.exists()).toBe(true)
    const saved = await file.json()
    expect(saved.id).toBe(topic.id)
  })

  it("reads a topic by id", async () => {
    const topic = await getTopic(topicId)
    expect(topic.id).toBe(topicId)
    expect(topic.title).toBe("Test Topic")
  })

  it("lists topics", async () => {
    const topics = await listTopics()
    expect(topics.length).toBeGreaterThanOrEqual(1)
    expect(topics.find(t => t.id === topicId)).toBeTruthy()
  })

  it("updates a topic", async () => {
    const updated = await updateTopic(topicId, { status: "discovery", title: "Updated Title" })
    expect(updated.status).toBe("discovery")
    expect(updated.title).toBe("Updated Title")

    // verify persisted
    const saved = await getTopic(topicId)
    expect(saved.status).toBe("discovery")
  })

  it("creates required subdirectories", async () => {
    const dirs = ["sources/raw", "sources/cache", "logs", "exports"]
    for (const dir of dirs) {
      const path = join(TEST_DATA_DIR, "topics", topicId, dir)
      const { stat } = await import("fs/promises")
      const s = await stat(path)
      expect(s.isDirectory()).toBe(true)
    }
  })

  it("creates empty JSON files for parties, clues, representatives, states", async () => {
    for (const file of ["parties.json", "clues.json", "representatives.json", "states.json"]) {
      const f = Bun.file(join(TEST_DATA_DIR, "topics", topicId, file))
      expect(await f.exists()).toBe(true)
      const content = await f.json()
      expect(Array.isArray(content)).toBe(true)
    }
  })

  it("deletes a topic", async () => {
    await deleteTopic(topicId)
    try {
      await getTopic(topicId)
      expect(true).toBe(false) // should not reach here
    } catch (e) {
      expect(String(e)).toContain("not found")
    }
  })
})

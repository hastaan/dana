import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { createTopic, getTopic, listTopics, updateTopic, deleteTopic } from "../src/pipeline/topicManager"
import { dbGetTopic } from "../src/db/queries/topics"
import { dbGetParties } from "../src/db/queries/parties"
import { dbGetClues } from "../src/db/queries/clues"
import { dbGetRepresentatives } from "../src/db/queries/forum"
import { resetDb } from "./setup"
import { join } from "path"
import { rm, mkdir } from "fs/promises"

const TEST_DATA_DIR = "/tmp/dana-test-data"

// Point DATA_DIR to temp dir for tests
process.env.DATA_DIR = TEST_DATA_DIR

beforeAll(async () => {
  await mkdir(join(TEST_DATA_DIR, "topics"), { recursive: true })
  resetDb()
})

afterAll(async () => {
  await rm(TEST_DATA_DIR, { recursive: true, force: true })
})

describe("TopicManager", () => {
  let topicId: string

  it("creates a topic persisted to the DB", async () => {
    const topic = await createTopic({
      title: "Test Topic",
      description: "A test topic for unit testing",
    })
    topicId = topic.id
    expect(topic.id).toBeTruthy()
    expect(topic.title).toBe("Test Topic")
    expect(topic.status).toBe("draft")
    expect(topic.current_version).toBe(0)

    // Topics persist to SQLite now (not topic.json on disk).
    const saved = dbGetTopic(topic.id)
    expect(saved?.id).toBe(topic.id)
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

  it("starts with empty parties, clues, and representatives in the DB", async () => {
    // parties/clues/representatives/states moved from JSON files to SQLite tables; a fresh topic
    // simply has no rows yet.
    expect(dbGetParties(topicId)).toEqual([])
    expect(dbGetClues(topicId)).toEqual([])
    expect(dbGetRepresentatives(topicId)).toEqual([])
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

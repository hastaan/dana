import { mkdirSync } from "fs"
import { join } from "path"
import { dbListTopics, dbGetTopic, dbCreateTopic, dbUpdateTopic, dbDeleteTopic } from "../db/queries/topics"
import { dbGetSettings } from "../db/queries/settings"

// Re-export Topic type for compatibility
export type { Topic } from "../db/queries/topics"

function getDataDir(): string {
  return process.env.DATA_DIR || "/home/nima/dana/data"
}

function topicDir(id: string): string {
  return join(getDataDir(), "topics", id)
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)
}

const DEFAULT_MODELS = {
  data_gathering: "claude-haiku-4-5-20251001",
  extraction: "claude-haiku-4-5-20251001",
  enrichment: "claude-sonnet-4-6",
  delta_updates: "claude-sonnet-4-6",
  forum_reasoning: "claude-opus-4-6",
  expert_council: "claude-opus-4-6",
  verdict: "claude-opus-4-6",
}

const DEFAULT_SETTINGS: Record<string, unknown> = {}

export async function listTopics() {
  return dbListTopics()
}

export async function getTopic(id: string) {
  const topic = dbGetTopic(id)
  if (!topic) throw new Error(`Topic not found: ${id}`)
  return topic
}

export async function createTopic(data: {
  title: string
  description: string
  models?: Record<string, string>
  settings?: Record<string, unknown>
}) {
  const id = slugify(data.title) + "-" + Date.now().toString(36)
  const dir = topicDir(id)

  // Still create raw source dirs for file-based caching
  mkdirSync(join(dir, "sources", "raw"), { recursive: true })
  mkdirSync(join(dir, "sources", "cache"), { recursive: true })
  mkdirSync(join(dir, "logs"), { recursive: true })
  mkdirSync(join(dir, "exports"), { recursive: true })

  const globalModels = dbGetSettings().default_models

  const topic = {
    id,
    title: data.title,
    description: data.description,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: "draft" as const,
    current_version: 0,
    models: { ...DEFAULT_MODELS, ...globalModels, ...data.models },
    settings: { ...DEFAULT_SETTINGS, ...(data.settings as object) },
  }

  dbCreateTopic(topic)
  return topic
}

export async function updateTopic(id: string, patch: Record<string, unknown>) {
  const updated = dbUpdateTopic(id, patch as any)
  if (!updated) throw new Error(`Topic not found: ${id}`)
  return updated
}

export async function deleteTopic(id: string): Promise<void> {
  dbDeleteTopic(id)
  // Also remove topic directory (sources/cache, etc.)
  try {
    const { rm } = await import("fs/promises")
    await rm(topicDir(id), { recursive: true, force: true })
  } catch { /* ignore if dir doesn't exist */ }
}

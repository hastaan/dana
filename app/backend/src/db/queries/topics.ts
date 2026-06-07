import { getDb } from "../database"

export interface Topic {
  id: string
  title: string
  description: string
  status: "draft" | "discovery" | "review_parties" | "enrichment" | "review_enrichment" | "forum_prep" | "review_forum_prep" | "forum" | "review_forum" | "expert_council" | "verdict" | "complete" | "stale"
  current_version: number
  models: {
    data_gathering: string
    extraction: string
    enrichment: string
    delta_updates: string
    forum_reasoning: string
    expert_council: string
    verdict: string
  }
  settings: Record<string, unknown>
  created_at: string
  updated_at: string
}

type TopicRow = {
  id: string
  title: string
  description: string
  status: string
  current_version: number
  models: string
  settings: string
  created_at: string
  updated_at: string
}

function rowToTopic(row: TopicRow): Topic {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status as Topic["status"],
    current_version: row.current_version,
    models: JSON.parse(row.models),
    settings: JSON.parse(row.settings),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function dbListTopics(): Topic[] {
  const rows = getDb().query<TopicRow, []>(
    "SELECT * FROM topics ORDER BY created_at DESC"
  ).all()
  return rows.map(rowToTopic)
}

export function dbGetTopic(id: string): Topic | null {
  const row = getDb().query<TopicRow, [string]>(
    "SELECT * FROM topics WHERE id = ?"
  ).get(id)
  return row ? rowToTopic(row) : null
}

export function dbCreateTopic(topic: Topic): void {
  getDb().run(
    `INSERT INTO topics (id, title, description, status, current_version, models, settings, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [topic.id, topic.title, topic.description, topic.status, topic.current_version,
     JSON.stringify(topic.models), JSON.stringify(topic.settings), topic.created_at, topic.updated_at]
  )
}

export function dbUpdateTopic(id: string, patch: Partial<Topic>): Topic | null {
  const existing = dbGetTopic(id)
  if (!existing) return null
  // Deep-merge settings one level so a partial settings patch can't silently wipe
  // sibling keys (e.g. steering) written by another route.
  const mergedSettings = patch.settings
    ? { ...existing.settings, ...patch.settings }
    : existing.settings
  const updated: Topic = { ...existing, ...patch, settings: mergedSettings, id, updated_at: new Date().toISOString() }
  getDb().run(
    `UPDATE topics SET title=?, description=?, status=?, current_version=?, models=?, settings=?, updated_at=? WHERE id=?`,
    [updated.title, updated.description, updated.status, updated.current_version,
     JSON.stringify(updated.models), JSON.stringify(updated.settings), updated.updated_at, id]
  )
  return updated
}

export function dbDeleteTopic(id: string): void {
  getDb().run("DELETE FROM topics WHERE id = ?", [id])
}

// Seed a committed demo topic into SQLite on first boot so a fresh clone shows a real
// analysis immediately (Enh 3). Import-if-absent: if the topic id already exists (incl.
// the original on the author's machine, or because the user kept/deleted it) we skip,
// so the demo is non-intrusive and deleting it sticks.
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { getDb } from "./database"
import { dbGetTopic } from "./queries/topics"
import { log } from "../utils/logger"

const SEED_PATH = join(import.meta.dir, "../../seed/demo-topic.json")

function insertRow(db: ReturnType<typeof getDb>, table: string, row: Record<string, unknown>): void {
  const cols = Object.keys(row)
  if (cols.length === 0) return
  const colList = cols.map(c => `"${c}"`).join(", ")
  const placeholders = cols.map(() => "?").join(", ")
  // OR IGNORE so a stray id/PK collision in a non-empty DB can't abort the whole seed.
  db.run(`INSERT OR IGNORE INTO ${table} (${colList}) VALUES (${placeholders})`, cols.map(c => row[c] as never))
}

export function seedDemoTopic(): void {
  if (!existsSync(SEED_PATH)) return

  let data: { topic?: Record<string, unknown>; tables?: Record<string, Record<string, unknown>[]> }
  try {
    data = JSON.parse(readFileSync(SEED_PATH, "utf8"))
  } catch (e) {
    log.error("SEED", "Could not parse demo fixture (skipping)", e)
    return
  }

  const topic = data.topic
  if (!topic?.id || typeof topic.id !== "string") return
  if (dbGetTopic(topic.id)) return // already present → skip (don't resurrect a deleted demo)

  const db = getDb()
  try {
    const txn = db.transaction(() => {
      insertRow(db, "topics", topic)
      for (const [table, rows] of Object.entries(data.tables ?? {})) {
        for (const row of rows) insertRow(db, table, row)
      }
    })
    txn()
    log.pipeline(`Seeded demo topic "${topic.title ?? topic.id}"`)
  } catch (e) {
    log.error("SEED", "Demo seed failed (non-fatal)", e)
  }
}

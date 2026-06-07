// Export a completed topic (all topic-scoped rows) to a committed JSON fixture so a
// fresh clone can show a real analysis out of the box (Enh 3). Excludes the research
// corpus (large, not needed to display). Usage:
//   bun run scripts/export-demo.ts [topicId]
import { Database } from "bun:sqlite"
import { writeFileSync, mkdirSync } from "fs"
import { join, dirname } from "path"

const TID = process.argv[2] || "iri-regime-collapse-and-formation-of-a-new-iranian-state-mnnfahns"
const DB_PATH = process.env.DANA_DB || join(process.env.DATA_DIR || "/home/nima/dana/data", "dana.db")
const OUT = join(import.meta.dir, "../app/backend/seed/demo-topic.json")

// All topic-scoped tables, in FK-safe insert order (parents before children).
const TABLES = [
  "parties", "clues", "clue_versions", "states", "representatives",
  "forum_sessions", "forum_rounds", "forum_turns", "forum_scenarios",
  "forum_scenario_summaries", "forum_scratchpads", "forum_supervisor_state",
  "expert_councils", "expert_assessments", "final_verdicts", "forecast_resolutions",
]

const db = new Database(DB_PATH, { readonly: true })
const topic = db.query<Record<string, unknown>, [string]>("SELECT * FROM topics WHERE id = ?").get(TID)
if (!topic) {
  console.error(`Topic not found: ${TID}`)
  process.exit(1)
}

// Mark the committed fixture as a demo so the UI can badge it.
try {
  const s = JSON.parse((topic.settings as string) || "{}")
  s.is_demo = true
  topic.settings = JSON.stringify(s)
} catch { /* leave settings as-is */ }

const tables: Record<string, unknown[]> = {}
for (const t of TABLES) {
  try {
    tables[t] = db.query(`SELECT * FROM ${t} WHERE topic_id = ?`).all(TID)
  } catch {
    tables[t] = []
  }
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify({ topic, tables }, null, 2))

console.log(`Exported "${topic.title}" → ${OUT}`)
for (const [t, rows] of Object.entries(tables)) console.log(`  ${t}: ${rows.length}`)

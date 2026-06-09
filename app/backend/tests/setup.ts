// Shared test harness for the backend integration suite.
//
// The data layer migrated from on-disk JSON files (clues.json, parties.json, …) to a single
// SQLite database (src/db/database.ts). Tests therefore can no longer seed by writing JSON to
// DATA_DIR; they must (a) initialize a DB and (b) insert fixtures through the db* query helpers.
//
// This module is wired in via bunfig.toml `[test] preload`, so it runs ONCE before any test file.
// It forces DATA_DIR to a throwaway temp dir and opens the DB against it, then exposes a
// resetDb() to wipe all rows between tests/files for isolation, plus typed seed helpers.
//
// NOTE: getDb() returns the connection opened here regardless of any later process.env.DATA_DIR
// reassignment a test file may do in its own beforeAll — the connection is already bound to the
// temp DB path below, so DB reads/writes always hit this harness DB. File-based artifacts
// (checkpoints, run logs, the httpFetch cache) still honor each file's DATA_DIR.
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// Bind DATA_DIR to a unique temp dir BEFORE importing the db module so initDb() picks it up.
const HARNESS_DATA_DIR = mkdtempSync(join(tmpdir(), "dana-backend-test-"))
process.env.DATA_DIR = HARNESS_DATA_DIR

const { initDb, getDb } = await import("../src/db/database")
import type { Clue, ClueVersion } from "../src/db/queries/clues"
import { dbReplaceClues } from "../src/db/queries/clues"
import type { Party } from "../src/db/queries/parties"
import { dbUpsertParty } from "../src/db/queries/parties"
import type { Topic } from "../src/db/queries/topics"
import { dbCreateTopic } from "../src/db/queries/topics"
import type { KnowledgeState } from "../src/db/queries/states"
import { dbInsertState } from "../src/db/queries/states"
import type { Representative } from "../src/db/queries/forum"
import { dbSetRepresentatives } from "../src/db/queries/forum"

export const TEST_DATA_DIR = HARNESS_DATA_DIR

// Open the connection once. Safe to call repeatedly (initDb just reassigns the singleton).
initDb()

// Every user table in the schema; cleared by resetDb() so each test starts from a clean slate.
const ALL_TABLES = [
  "forecast_resolutions", "research_pages", "research_searches", "prompt_configs", "app_settings",
  "forum_supervisor_state", "forum_scratchpads", "final_verdicts", "expert_assessments",
  "expert_councils", "forum_scenario_summaries", "forum_scenarios", "forum_turns", "forum_rounds",
  "forum_sessions", "representatives", "states", "clue_versions", "clues", "parties", "topics",
]

export function resetDb(): void {
  const db = getDb()
  db.run("PRAGMA foreign_keys = OFF")
  for (const table of ALL_TABLES) {
    try { db.run(`DELETE FROM ${table}`) } catch { /* table may not exist in older schema */ }
  }
  db.run("PRAGMA foreign_keys = ON")
}

const DEFAULT_MODELS: Topic["models"] = {
  data_gathering: "claude-haiku-4-5",
  extraction: "claude-haiku-4-5",
  enrichment: "claude-sonnet-4-6",
  delta_updates: "claude-sonnet-4-6",
  forum_reasoning: "claude-opus-4-6",
  expert_council: "claude-opus-4-6",
  verdict: "claude-opus-4-6",
}

// Insert a topic row. Clues/parties/states FK to topics, so seed a topic first.
export function seedTopic(id: string, overrides: Partial<Topic> = {}): Topic {
  const now = new Date().toISOString()
  const topic: Topic = {
    id,
    title: overrides.title ?? id,
    description: overrides.description ?? "",
    status: overrides.status ?? "draft",
    current_version: overrides.current_version ?? 0,
    models: overrides.models ?? DEFAULT_MODELS,
    settings: overrides.settings ?? {},
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
  }
  dbCreateTopic(topic)
  return topic
}

// Build a fully-shaped Party from a partial (fills required nested fields with neutral defaults).
export function makeParty(partial: Partial<Party> & { id: string; name: string }): Party {
  return {
    type: "non_state",
    description: "",
    weight: 0,
    weight_factors: { military_capacity: 0, economic_control: 0, information_control: 0, international_support: 0, internal_legitimacy: 0 },
    agenda: "",
    means: [],
    circle: { visible: [], shadow: [] },
    stance: "passive",
    vulnerabilities: [],
    auto_discovered: true,
    user_verified: false,
    ...partial,
  }
}

export function seedParties(topicId: string, parties: (Partial<Party> & { id: string; name: string })[]): void {
  for (const p of parties) dbUpsertParty(topicId, makeParty(p))
}

// Build a single-version ClueVersion from a partial.
export function makeClueVersion(partial: Partial<ClueVersion> & { v: number; title: string }): ClueVersion {
  return {
    date: "",
    timeline_date: "",
    raw_source: { urls: [], outlets: [], fetched_at: "" },
    source_credibility: { score: 0, notes: "", bias_flags: [], origin_sources: [] },
    bias_corrected_summary: "",
    relevance_score: 0,
    party_relevance: [],
    domain_tags: [],
    clue_type: "event",
    change_note: "",
    key_points: [],
    ...partial,
  }
}

// Build a Clue (with one or more versions) from a partial. `current` defaults to the highest version.
export function makeClue(partial: Partial<Clue> & { id: string; versions: ClueVersion[] }): Clue {
  const versions = partial.versions
  return {
    current: partial.current ?? Math.max(...versions.map(v => v.v)),
    added_at: partial.added_at ?? "",
    last_updated_at: partial.last_updated_at ?? "",
    added_by: partial.added_by ?? "auto",
    status: partial.status ?? "verified",
    ...partial,
  }
}

export function seedClues(topicId: string, clues: Clue[]): void {
  dbReplaceClues(topicId, clues)
}

export function seedState(topicId: string, partial: Partial<KnowledgeState> & { version: number }): void {
  dbInsertState(topicId, {
    label: partial.label ?? `v${partial.version}`,
    created_at: partial.created_at ?? new Date().toISOString(),
    trigger: partial.trigger ?? "initial_run",
    clue_snapshot: partial.clue_snapshot ?? { count: 0, ids_and_versions: {} },
    forum_session_id: partial.forum_session_id ?? null,
    verdict_id: partial.verdict_id ?? null,
    delta_from: partial.delta_from ?? null,
    delta_summary: partial.delta_summary ?? null,
    parent_version: partial.parent_version ?? null,
    fork_stage: partial.fork_stage ?? null,
    parties_snapshot: partial.parties_snapshot ?? null,
    representatives_snapshot: partial.representatives_snapshot ?? null,
    completed_stages: partial.completed_stages ?? [],
    version: partial.version,
    version_status: partial.version_status ?? "complete",
  })
}

export function seedRepresentatives(topicId: string, reps: Representative[]): void {
  dbSetRepresentatives(topicId, reps)
}

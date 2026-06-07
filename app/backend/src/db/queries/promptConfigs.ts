import { getDb } from "../database"
import type { TaskProfile } from "../../llm/modelCatalog"

export interface PromptConfig {
  model: string | null
  tools: string[]
}

const cache = new Map<string, PromptConfig>()
let allLoaded = false

const DEFAULT_CONFIG: PromptConfig = { model: null, tools: [] }

interface PromptDefault {
  tools: string[]
  task_profile: TaskProfile
}

export const BUILTIN_DEFAULTS: Record<string, PromptDefault> = {
  // Agentic tasks — tools + balanced
  "discovery/agentic-research":  { tools: ["web_search", "fetch_url"], task_profile: "balanced" },
  "enrichment/agentic-enrich":   { tools: ["web_search", "fetch_url"], task_profile: "balanced" },
  "enrichment/fact-check":       { tools: ["web_search", "fetch_url"], task_profile: "balanced" },
  "party-intelligence/edit":     { tools: ["web_search", "fetch_url"], task_profile: "balanced" },
  "clue-extractor/edit":         { tools: ["web_search", "fetch_url"], task_profile: "balanced" },

  // Fast tasks — extraction, queries, categorization
  "discovery/orient":            { tools: [], task_profile: "fast" },
  "discovery/refine-parties":    { tools: [], task_profile: "fast" },
  "discovery/score-axes":        { tools: ["web_search", "fetch_url"], task_profile: "balanced" },
  "clue-extractor/extract":      { tools: [], task_profile: "fast" },
  "clue-extractor/queries":      { tools: [], task_profile: "fast" },
  "clue-extractor/research":     { tools: [], task_profile: "fast" },
  "clue-extractor/cleanup-scan":    { tools: [], task_profile: "fast" },
  "clue-extractor/cleanup-resolve": { tools: [], task_profile: "balanced" },
  "clue-processor/system":       { tools: [], task_profile: "fast" },

  // Balanced tasks — synthesis, intelligence
  "weight/weight-scoring":       { tools: [], task_profile: "balanced" },
  "weight/persona-generation":   { tools: [], task_profile: "balanced" },
  "party-intelligence/add":      { tools: [], task_profile: "balanced" },
  "party-intelligence/split":    { tools: [], task_profile: "balanced" },
  "party-intelligence/merge":    { tools: [], task_profile: "balanced" },

  // Deep reasoning — forum debate, scoring, advocacy
  "forum/scratchpad":            { tools: [], task_profile: "deep_reasoning" },
  "forum/representative-turn":   { tools: [], task_profile: "deep_reasoning" },

  "forum/supervisor-scenarios":  { tools: [], task_profile: "deep_reasoning" },
  "forum/supervisor-moderate":   { tools: [], task_profile: "deep_reasoning" },
  "forum/scenario-synthesis":    { tools: [], task_profile: "deep_reasoning" },
  "forum/delta-scenario-impact": { tools: [], task_profile: "deep_reasoning" },
  "scoring/score-scenarios":     { tools: [], task_profile: "deep_reasoning" },

  "representative/base":         { tools: [], task_profile: "deep_reasoning" },
  "delta-representative/system": { tools: [], task_profile: "deep_reasoning" },
}

export function getTaskProfile(promptName: string): TaskProfile | null {
  return BUILTIN_DEFAULTS[promptName]?.task_profile ?? null
}

export function seedDefaults(): void {
  const db = getDb()
  for (const [name, def] of Object.entries(BUILTIN_DEFAULTS)) {
    if (def.tools.length === 0) continue // only seed entries with tools
    const existing = db.query<{ name: string }, [string]>(
      "SELECT name FROM prompt_configs WHERE name = ?"
    ).get(name)
    if (!existing) {
      db.run(
        `INSERT INTO prompt_configs (name, model, tools, updated_at) VALUES (?, NULL, ?, ?)`,
        [name, JSON.stringify(def.tools), new Date().toISOString()]
      )
    }
  }
}

function parseRow(row: { model: string | null; tools: string }): PromptConfig {
  let tools: string[] = []
  try { tools = JSON.parse(row.tools) } catch { /* empty */ }
  return { model: row.model, tools }
}

export function getPromptConfig(name: string): PromptConfig {
  if (cache.has(name)) return cache.get(name)!
  const row = getDb().query<{ model: string | null; tools: string }, [string]>(
    "SELECT model, tools FROM prompt_configs WHERE name = ?"
  ).get(name)
  const config = row ? parseRow(row) : DEFAULT_CONFIG
  cache.set(name, config)
  return config
}

export function setPromptConfig(name: string, update: { model?: string | null; tools?: string[] }): PromptConfig {
  const current = getPromptConfig(name)
  const next: PromptConfig = {
    model: update.model !== undefined ? update.model : current.model,
    tools: update.tools !== undefined ? update.tools : current.tools,
  }
  getDb().run(
    `INSERT INTO prompt_configs (name, model, tools, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET model=excluded.model, tools=excluded.tools, updated_at=excluded.updated_at`,
    [name, next.model, JSON.stringify(next.tools), new Date().toISOString()]
  )
  cache.set(name, next)
  return next
}

export function getAllPromptConfigs(): Record<string, PromptConfig> {
  if (allLoaded) {
    const result: Record<string, PromptConfig> = {}
    for (const [k, v] of cache) result[k] = v
    return result
  }
  const rows = getDb().query<{ name: string; model: string | null; tools: string }, []>(
    "SELECT name, model, tools FROM prompt_configs"
  ).all()
  const result: Record<string, PromptConfig> = {}
  for (const row of rows) {
    const config = parseRow(row)
    cache.set(row.name, config)
    result[row.name] = config
  }
  allLoaded = true
  return result
}

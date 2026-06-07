import { getDb } from "../database"

export const TASK_CATEGORIES = [
  "data_gathering",
  "extraction",
  "enrichment",
  "delta_updates",
  "forum_reasoning",
  "expert_council",
  "verdict",
] as const

export type TaskCategory = typeof TASK_CATEGORIES[number]

export const DEFAULT_MODELS: Record<TaskCategory, string> = {
  data_gathering: "claude-haiku-4-5-20251001",
  extraction: "claude-haiku-4-5-20251001",
  enrichment: "claude-sonnet-4-6",
  delta_updates: "claude-sonnet-4-6",
  forum_reasoning: "claude-opus-4-6",
  expert_council: "claude-opus-4-6",
  verdict: "claude-opus-4-6",
}

export interface AnalysisControls {
  // Discovery
  discovery_research_iterations: number
  discovery_context_warning: number
  scoring_iterations: number
  scoring_context_warning: number
  scoring_batch_size: number
  scoring_ensemble_runs: number   // N independent scorer runs; >1 → report mean ± spread
  // Enrichment
  enrichment_iterations: number
  enrichment_context_warning: number
  enrichment_batch_size: number
  enrichment_max_searches_per_round: number
  enrichment_max_fetches_per_round: number
  fact_check_iterations: number
  smart_extract_url_limit: number
  research_search_queries: number
  // Smart Edit
  smart_edit_queries: number
  smart_edit_max_chars: number
  // Bulk Import
  bulk_import_iterations: number
  bulk_import_chunk_target_chars: number
  bulk_import_chunk_max_chars: number
  bulk_fact_check_iterations: number
  // Evidence Update
  evidence_update_batch_size: number
  evidence_update_iterations: number
  // Cleanup
  cleanup_fact_check_iterations: number
  // Forum
  forum_max_turns: number
  forum_compress_interval: number
  forum_speaking_budget: number
  forum_scenario_update_interval: number
  forum_min_turns_multiplier: number
  // Agentic Loop defaults
  max_fetch_chars: number
  corpus_cache_hours: number
}

export const DEFAULT_CONTROLS: AnalysisControls = {
  // Discovery
  discovery_research_iterations: 5,
  discovery_context_warning: 120000,
  scoring_iterations: 3,
  scoring_context_warning: 100000,
  scoring_batch_size: 2,
  scoring_ensemble_runs: 1,
  // Enrichment
  enrichment_iterations: 8,
  enrichment_context_warning: 100000,
  enrichment_batch_size: 2,
  enrichment_max_searches_per_round: 3,
  enrichment_max_fetches_per_round: 5,
  fact_check_iterations: 3,
  smart_extract_url_limit: 10,
  research_search_queries: 4,
  // Smart Edit
  smart_edit_queries: 3,
  smart_edit_max_chars: 15000,
  // Bulk Import
  bulk_import_iterations: 5,
  bulk_import_chunk_target_chars: 2000,
  bulk_import_chunk_max_chars: 4000,
  bulk_fact_check_iterations: 2,
  // Evidence Update
  evidence_update_batch_size: 3,
  evidence_update_iterations: 3,
  // Cleanup
  cleanup_fact_check_iterations: 2,
  // Forum
  forum_max_turns: 60,
  forum_compress_interval: 10,
  forum_speaking_budget: 600,
  forum_scenario_update_interval: 5,
  forum_min_turns_multiplier: 2.5,
  // Agentic Loop defaults
  max_fetch_chars: 10000,
  corpus_cache_hours: 24,
}

export interface AppSettings {
  default_models: Record<string, string>
  analysis_controls: AnalysisControls
  // Global default operator steering (see llm/steering.ts). Loosely typed here to
  // avoid a circular import; the canonical shape is AnalystGuidance.
  steering?: Record<string, string>
}

export function dbGetSettings(): AppSettings {
  const row = getDb().query<{ value: string }, [string]>(
    "SELECT value FROM app_settings WHERE key = ?"
  ).get("app_settings")
  if (!row) return { default_models: DEFAULT_MODELS, analysis_controls: DEFAULT_CONTROLS, steering: {} }
  try {
    const parsed = JSON.parse(row.value)
    return {
      default_models: parsed.default_models ?? DEFAULT_MODELS,
      analysis_controls: { ...DEFAULT_CONTROLS, ...(parsed.analysis_controls ?? {}) },
      steering: parsed.steering ?? {},
    }
  } catch {
    return { default_models: DEFAULT_MODELS, analysis_controls: DEFAULT_CONTROLS, steering: {} }
  }
}

export function dbSaveSettings(settings: AppSettings): void {
  getDb().run(
    `INSERT INTO app_settings (key, value) VALUES ('app_settings', ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    [JSON.stringify(settings)]
  )
}

export function dbGetDefaultModels(): Record<string, string> {
  return dbGetSettings().default_models
}

export function dbGetControls(): AnalysisControls {
  return dbGetSettings().analysis_controls
}

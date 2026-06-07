import { Elysia, t } from "elysia"
import { DEFAULT_MODELS, DEFAULT_CONTROLS, TASK_CATEGORIES, dbGetSettings, dbSaveSettings } from "../db/queries/settings"
import type { AnalysisControls } from "../db/queries/settings"

export async function getDefaultModels(): Promise<Record<string, string>> {
  return dbGetSettings().default_models
}

const CONTROL_RANGES: Record<keyof AnalysisControls, [number, number]> = {
  // Discovery
  discovery_research_iterations: [2, 30],
  discovery_context_warning: [50000, 200000],
  scoring_iterations: [2, 20],
  scoring_context_warning: [50000, 200000],
  scoring_batch_size: [1, 8],
  scoring_ensemble_runs: [1, 5],
  // Enrichment
  enrichment_iterations: [2, 25],
  enrichment_context_warning: [50000, 200000],
  enrichment_batch_size: [1, 8],
  enrichment_search_results: [3, 10],
  enrichment_max_searches_per_round: [1, 5],
  enrichment_max_fetches_per_round: [2, 10],
  fact_check_iterations: [1, 8],
  smart_extract_url_limit: [3, 30],
  research_search_queries: [2, 20],
  // Smart Edit
  smart_edit_queries: [1, 6],
  smart_edit_max_chars: [5000, 50000],
  // Forum
  forum_max_turns: [20, 200],
  forum_compress_interval: [5, 50],
  forum_speaking_budget: [200, 1200],
  forum_scenario_update_interval: [3, 20],
  forum_min_turns_multiplier: [1.5, 5],
  // Agentic Loop
  default_max_iterations: [5, 20],
  default_context_warning: [50000, 300000],
  max_fetch_chars: [10000, 80000],
  corpus_cache_hours: [24, 72],
}

function clampControls(input: Partial<AnalysisControls>): Partial<AnalysisControls> {
  const clamped: Partial<AnalysisControls> = {}
  for (const [key, value] of Object.entries(input)) {
    const k = key as keyof AnalysisControls
    const range = CONTROL_RANGES[k]
    if (range && typeof value === "number") {
      clamped[k] = Math.max(range[0], Math.min(range[1], Math.round(value)))
    }
  }
  return clamped
}

export const settingsRouter = new Elysia({ prefix: "/api/settings" })
  .get("/", () => dbGetSettings())
  .put("/", ({ body }) => {
    console.log("[SETTINGS] PUT received:", JSON.stringify(body).slice(0, 200))
    const settings = dbGetSettings()

    if (body.default_models) {
      settings.default_models = {
        ...DEFAULT_MODELS,
        ...settings.default_models,
        ...Object.fromEntries(TASK_CATEGORIES.map(category => [category, body.default_models?.[category] ?? settings.default_models[category] ?? DEFAULT_MODELS[category]])),
      }
    }

    if (body.analysis_controls) {
      const clamped = clampControls(body.analysis_controls)
      settings.analysis_controls = { ...settings.analysis_controls, ...clamped }
    }

    if (body.steering) {
      settings.steering = body.steering as Record<string, string>
    }

    dbSaveSettings(settings)
    return settings
  }, {
    body: t.Object({
      default_models: t.Optional(t.Record(t.String(), t.String())),
      analysis_controls: t.Optional(t.Record(t.String(), t.Number())),
      steering: t.Optional(t.Object({
        framing_note: t.Optional(t.String({ maxLength: 4000 })),
        research_guidance: t.Optional(t.String({ maxLength: 4000 })),
        evidence_guidance: t.Optional(t.String({ maxLength: 4000 })),
        debate_guidance: t.Optional(t.String({ maxLength: 4000 })),
      })),
    })
  })

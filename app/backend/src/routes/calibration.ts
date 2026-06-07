// Forecast resolution + calibration API (Enh 4a). Lets an analyst record which
// scenario actually occurred and scores the recorded forecast (Brier + log score),
// then aggregates calibration across all resolved topics.
import { Elysia, t } from "elysia"
import { getTopic } from "../pipeline/topicManager"
import { dbGetExpertCouncil, dbGetLatestExpertCouncil } from "../db/queries/expert"
import {
  computeScores,
  dbSaveResolution,
  dbGetResolution,
  dbDeleteResolution,
  dbCalibrationSummary,
  type ForecastEntry,
} from "../db/queries/calibration"

export const calibrationRouter = new Elysia()
  // Cross-topic calibration summary (Brier, log score, reliability bins)
  .get("/api/calibration", () => dbCalibrationSummary())

  // Get the resolution for a topic version (or null)
  .get("/api/topics/:id/resolution", ({ params, query }) => {
    if (query.version != null) {
      const version = parseInt(String(query.version))
      if (Number.isNaN(version)) return { resolution: null }
      return { resolution: dbGetResolution(params.id, version) }
    }
    const council = dbGetLatestExpertCouncil(params.id)
    if (!council) return { resolution: null }
    return { resolution: dbGetResolution(params.id, council.version) }
  })

  // Record which scenario actually occurred → compute & store Brier/log score
  .post("/api/topics/:id/resolve", async ({ params, body, set }) => {
    try {
      await getTopic(params.id)
    } catch {
      set.status = 404
      return { message: "Topic not found" }
    }

    // Determine version (explicit, else latest scored)
    let version = body.version
    let council = version != null ? dbGetExpertCouncil(params.id, version) : dbGetLatestExpertCouncil(params.id)
    if (!council) {
      set.status = 400
      return { message: "No scored verdict found for this topic/version to resolve against" }
    }
    version = council.version
    const ranked = council.final_verdict?.scenarios_ranked ?? []
    if (ranked.length === 0) {
      set.status = 400
      return { message: "Verdict has no ranked scenarios" }
    }

    const forecast: ForecastEntry[] = ranked.map(s => ({
      scenario_id: s.scenario_id,
      title: s.title ?? s.scenario_id,
      probability: typeof s.probability === "number" ? s.probability : 0,
    }))

    if (!forecast.some(f => f.scenario_id === body.resolved_scenario_id)) {
      set.status = 400
      return { message: `resolved_scenario_id "${body.resolved_scenario_id}" is not in this verdict's scenarios` }
    }

    const { brier, logScore } = computeScores(forecast, body.resolved_scenario_id)

    dbSaveResolution({
      topic_id: params.id,
      version,
      resolved_scenario_id: body.resolved_scenario_id,
      resolved_at: new Date().toISOString(),
      notes: body.notes ?? null,
      brier_score: brier,
      log_score: logScore,
      forecast,
    })

    return { ok: true, version, brier_score: brier, log_score: logScore }
  }, {
    body: t.Object({
      resolved_scenario_id: t.String(),
      version: t.Optional(t.Number()),
      notes: t.Optional(t.String({ maxLength: 2000 })),
    }),
  })

  // Un-resolve (clear) a topic version's resolution
  .delete("/api/topics/:id/resolution", ({ params, query }) => {
    const council = dbGetLatestExpertCouncil(params.id)
    const version = query.version ? parseInt(String(query.version)) : council?.version
    if (version == null || Number.isNaN(version)) {
      return { ok: false, message: "No version to clear" }
    }
    dbDeleteResolution(params.id, version)
    return { ok: true }
  })

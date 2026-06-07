// Forecast resolution + calibration scoring (Enh 4a). When an analyst marks which
// scenario actually occurred, we score the recorded forecast with the Brier score
// and log score — the standard way to measure whether a forecaster is calibrated.
import { getDb } from "../database"

export interface ForecastEntry {
  scenario_id: string
  title: string
  probability: number
}

export interface ForecastResolution {
  topic_id: string
  version: number
  resolved_scenario_id: string
  resolved_at: string
  notes: string | null
  brier_score: number
  log_score: number | null
  forecast: ForecastEntry[]
}

const round = (n: number) => Math.round(n * 1e6) / 1e6

// Multi-class Brier score: Σ (p_i − o_i)^2 over all scenarios (o_i = 1 for the
// resolved scenario, else 0). Lower is better; 0 = perfect, 2 = maximally wrong.
// Log score: −ln(p_resolved). Lower is better.
export function computeScores(
  forecast: ForecastEntry[],
  resolvedId: string,
): { brier: number; logScore: number; pResolved: number } {
  let brier = 0
  let pResolved = 0
  for (const f of forecast) {
    const p = typeof f.probability === "number" ? f.probability : 0
    const o = f.scenario_id === resolvedId ? 1 : 0
    brier += (p - o) ** 2
    if (o === 1) pResolved = p
  }
  const logScore = -Math.log(Math.max(pResolved, 1e-6))
  return { brier: round(brier), logScore: round(logScore), pResolved: round(pResolved) }
}

export function dbSaveResolution(r: ForecastResolution): void {
  getDb().run(
    `INSERT INTO forecast_resolutions (topic_id, version, resolved_scenario_id, resolved_at, notes, brier_score, log_score, forecast)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(topic_id, version) DO UPDATE SET
       resolved_scenario_id=excluded.resolved_scenario_id, resolved_at=excluded.resolved_at,
       notes=excluded.notes, brier_score=excluded.brier_score, log_score=excluded.log_score, forecast=excluded.forecast`,
    [r.topic_id, r.version, r.resolved_scenario_id, r.resolved_at, r.notes,
     r.brier_score, r.log_score, JSON.stringify(r.forecast)],
  )
}

type Row = {
  topic_id: string; version: number; resolved_scenario_id: string; resolved_at: string
  notes: string | null; brier_score: number; log_score: number | null; forecast: string
}

function rowToResolution(row: Row): ForecastResolution {
  return { ...row, forecast: JSON.parse(row.forecast) as ForecastEntry[] }
}

export function dbGetResolution(topicId: string, version: number): ForecastResolution | null {
  const row = getDb().query<Row, [string, number]>(
    "SELECT * FROM forecast_resolutions WHERE topic_id = ? AND version = ?",
  ).get(topicId, version)
  return row ? rowToResolution(row) : null
}

export function dbDeleteResolution(topicId: string, version: number): void {
  getDb().run("DELETE FROM forecast_resolutions WHERE topic_id = ? AND version = ?", [topicId, version])
}

export interface CalibrationSummary {
  count: number
  mean_brier: number | null
  mean_log_score: number | null
  resolutions: (ForecastResolution & { topic_title?: string })[]
  // Multi-class (one-vs-all) reliability: EVERY (scenario, outcome) pair across all
  // resolutions is binned by predicted probability — the resolved scenario contributes
  // outcome=1, all others outcome=0. `n` is the number of such pairs in the bucket
  // (not the number of forecasts). Well-calibrated ⇒ predicted_mean ≈ observed_rate.
  reliability: { bucket: string; predicted_mean: number; observed_rate: number; n: number }[]
}

export function dbCalibrationSummary(): CalibrationSummary {
  const db = getDb()
  const rows = db.query<Row & { topic_title: string }, []>(
    `SELECT fr.*, t.title AS topic_title FROM forecast_resolutions fr
     LEFT JOIN topics t ON t.id = fr.topic_id ORDER BY fr.resolved_at DESC`,
  ).all()
  const resolutions = rows.map(r => ({ ...rowToResolution(r), topic_title: r.topic_title }))

  const count = resolutions.length
  const meanBrier = count ? round(resolutions.reduce((s, r) => s + r.brier_score, 0) / count) : null
  const logs = resolutions.map(r => r.log_score).filter((x): x is number => x != null)
  const meanLog = logs.length ? round(logs.reduce((s, x) => s + x, 0) / logs.length) : null

  // Reliability: each resolution contributes (p_resolved → outcome=1) plus the
  // non-resolved forecasts (p → outcome=0), binned into deciles.
  const buckets = new Map<number, { pSum: number; oSum: number; n: number }>()
  for (const r of resolutions) {
    for (const f of r.forecast) {
      const o = f.scenario_id === r.resolved_scenario_id ? 1 : 0
      const b = Math.min(9, Math.floor((f.probability ?? 0) * 10))
      const cur = buckets.get(b) ?? { pSum: 0, oSum: 0, n: 0 }
      cur.pSum += f.probability ?? 0; cur.oSum += o; cur.n += 1
      buckets.set(b, cur)
    }
  }
  const reliability = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([b, v]) => ({
    bucket: `${b * 10}-${b * 10 + 10}%`,
    predicted_mean: round(v.pSum / v.n),
    observed_rate: round(v.oSum / v.n),
    n: v.n,
  }))

  return { count, mean_brier: meanBrier, mean_log_score: meanLog, resolutions, reliability }
}

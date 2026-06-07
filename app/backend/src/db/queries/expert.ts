import { getDb } from "../database"
import type { ExpertArtifact, ExpertCouncilOutput, ExpertPersona, FinalVerdict } from "../../agents/ExpertAgent"

type CouncilRow = {
  id: number; topic_id: string; version: number; verdict_id: string | null
  created_at: string; experts: string; evidence_map: string | null
}
type AssessmentRow = {
  id: number; council_id: number; topic_id: string; expert_id: string; expert_name: string
  domain: string; scenario_assessments: string; weight_challenges: string; deliberation_text: string | null
}
type VerdictRow = {
  id: number; council_id: number; topic_id: string; synthesized_at: string
  scenarios_ranked: string; final_assessment: string; confidence_note: string; weight_challenge_decisions: string
  debate_summary: string | null
  steering: string | null
}

export function dbSaveExpertCouncil(topicId: string, output: ExpertCouncilOutput): void {
  const db = getDb()
  const txn = db.transaction(() => {
    // Delete existing council for same topic+version (allows re-runs)
    const existing = db.query<{ id: number }, [string, number]>(
      "SELECT id FROM expert_councils WHERE topic_id = ? AND version = ?"
    ).get(topicId, output.version)
    if (existing) {
      db.run("DELETE FROM final_verdicts WHERE council_id = ?", [existing.id])
      db.run("DELETE FROM expert_assessments WHERE council_id = ?", [existing.id])
      db.run("DELETE FROM expert_councils WHERE id = ?", [existing.id])
      // The probabilities are changing → any recorded resolution/Brier for this version
      // no longer matches. Drop it so calibration isn't scored against stale forecasts.
      db.run("DELETE FROM forecast_resolutions WHERE topic_id = ? AND version = ?", [topicId, output.version])
    }

    db.run(
      `INSERT INTO expert_councils (topic_id, version, verdict_id, created_at, experts, evidence_map)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [topicId, output.version, output.verdict_id, new Date().toISOString(), JSON.stringify(output.experts), JSON.stringify(output.evidence_map ?? [])]
    )
    const councilId = db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id

    for (const d of output.deliberations) {
      db.run(
        `INSERT INTO expert_assessments (council_id, topic_id, expert_id, expert_name, domain, scenario_assessments, weight_challenges, deliberation_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [councilId, topicId, d.expert_id, d.expert_name, d.domain,
         JSON.stringify(d.scenario_assessments), JSON.stringify(d.weight_challenges),
         d.cross_deliberation_response ?? null]
      )
    }

    if (output.final_verdict) {
      const v = output.final_verdict
      db.run(
        `INSERT INTO final_verdicts (council_id, topic_id, synthesized_at, scenarios_ranked, final_assessment, confidence_note, weight_challenge_decisions, debate_summary, steering)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [councilId, topicId, v.synthesized_at, JSON.stringify(v.scenarios_ranked),
         v.final_assessment, v.confidence_note, JSON.stringify(v.weight_challenge_decisions),
         v.debate_summary ?? null, v.steering ? JSON.stringify(v.steering) : null]
      )
    }
  })
  txn()
}

export function dbGetExpertCouncil(topicId: string, version: number): ExpertCouncilOutput | null {
  const db = getDb()
  const councilRow = db.query<CouncilRow, [string, number]>(
    "SELECT * FROM expert_councils WHERE topic_id = ? AND version = ?"
  ).get(topicId, version)
  if (!councilRow) return null

  const assessmentRows = db.query<AssessmentRow, [number]>(
    "SELECT * FROM expert_assessments WHERE council_id = ?"
  ).all(councilRow.id)

  const deliberations: ExpertArtifact[] = assessmentRows.map(r => ({
    expert_id: r.expert_id,
    expert_name: r.expert_name,
    domain: r.domain,
    scenario_assessments: JSON.parse(r.scenario_assessments),
    weight_challenges: JSON.parse(r.weight_challenges),
    cross_deliberation_response: r.deliberation_text ?? undefined,
  }))

  const verdictRow = db.query<VerdictRow, [number]>(
    "SELECT * FROM final_verdicts WHERE council_id = ?"
  ).get(councilRow.id)

  const finalVerdict: FinalVerdict | undefined = verdictRow ? {
    synthesized_at: verdictRow.synthesized_at,
    scenarios_ranked: JSON.parse(verdictRow.scenarios_ranked),
    final_assessment: verdictRow.final_assessment,
    confidence_note: verdictRow.confidence_note,
    weight_challenge_decisions: JSON.parse(verdictRow.weight_challenge_decisions),
    debate_summary: verdictRow.debate_summary ?? undefined,
    steering: verdictRow.steering ? JSON.parse(verdictRow.steering) : null,
  } : undefined

  return {
    version: councilRow.version,
    verdict_id: councilRow.verdict_id ?? `verdict-v${councilRow.version}`,
    experts: JSON.parse(councilRow.experts),
    deliberations,
    final_verdict: finalVerdict,
    evidence_map: councilRow.evidence_map ? JSON.parse(councilRow.evidence_map) : undefined,
  }
}

export function dbGetLatestExpertCouncil(topicId: string): ExpertCouncilOutput | null {
  type Row = { version: number }
  const row = getDb().query<Row, [string]>(
    "SELECT version FROM expert_councils WHERE topic_id = ? ORDER BY version DESC LIMIT 1"
  ).get(topicId)
  if (!row) return null
  return dbGetExpertCouncil(topicId, row.version)
}

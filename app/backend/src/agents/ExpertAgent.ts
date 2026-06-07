// Shared type definitions for the expert council / scenario scoring layer.
// Runtime implementation is in ScenarioScorer.ts.

import type { AnalystGuidance } from "../llm/steering"

export interface ExpertPersona {
  id: string
  name: string
  domain: string
  persona_prompt: string
  auto_generated: boolean
}

export interface ScenarioAssessment {
  scenario_id: string
  assessment: string
  historic_analogues: string[]
  weak_points_identified: string[]
  probability_contribution: number
}

export interface WeightChallenge {
  party_id: string
  dimension: string
  original_score: number
  suggested_score: number
  reasoning: string
  clues_cited: string[]
}

export interface ExpertArtifact {
  expert_id: string
  expert_name: string
  domain: string
  scenario_assessments: ScenarioAssessment[]
  weight_challenges: WeightChallenge[]
  cross_deliberation_response?: string
}

export interface ExpertCouncilOutput {
  version: number
  verdict_id: string
  experts: ExpertPersona[]
  deliberations: ExpertArtifact[]
  final_verdict?: FinalVerdict
  evidence_map?: any[]           // ScenarioEvidence[] persisted from scorer
}

export interface PowerBalance {
  backing_parties: { party_id: string; party_name: string; weight: number }[]
  opposing_parties: { party_id: string; party_name: string; weight: number }[]
  net_power: number
  forum_support_ratio: string      // e.g. "7:2"
  weight_adjusted_ratio: string    // e.g. "180:120"
  explanation: string
}

export interface RankedScenario {
  scenario_id: string
  title: string
  probability: number
  confidence: "high" | "medium" | "low"
  evidence_chain?: string
  key_drivers: string[]
  watch_indicators: string[]
  falsifying_conditions?: string[]
  near_future_trajectories?: {
    "90_days": string
    "6_months": string
    "1_year": string
  }
  power_balance?: PowerBalance
  // ── Scientific-rigor fields (Enh 4) ──
  base_rate?: number              // outside-view reference-class prior (0–1)
  base_rate_reasoning?: string    // reference class + why the estimate deviates from it
  resolution_criteria?: string    // objective, checkable condition that would confirm this scenario
  resolution_date?: string        // when the scenario should be resolvable (ISO date or horizon)
  probability_range?: {           // ensemble uncertainty band (present when ensemble runs > 1)
    low: number
    high: number
  }
}

export interface WeightChallengeDecision {
  party_id: string
  dimension: string
  original_score: number
  applied_score: number
  status: "accepted" | "rejected"
  reason: string
  flagged_by: string[]
  defended_by: string[]
}

export interface FinalVerdict {
  synthesized_at: string
  scenarios_ranked: RankedScenario[]
  final_assessment: string
  confidence_note: string
  weight_challenge_decisions: WeightChallengeDecision[]
  debate_summary?: string
  // Provenance: operator steering active when this verdict was produced (epistemic
  // guidance only — recorded for auditability). Null when no steering was set.
  steering?: AnalystGuidance | null
}

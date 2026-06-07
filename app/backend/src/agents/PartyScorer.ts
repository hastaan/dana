import { resolvePrompt } from "../llm/promptLoader"
import { runAgenticLoop } from "../llm/agenticLoop"
import { dbGetControls } from "../db/queries/settings"
import { budgetOutput } from "../llm/tokenBudget"
import { emitThink } from "../routes/stream"
import { log } from "../utils/logger"
import type { Party } from "./DiscoveryAgent"

const AXIS_KEYS = [
  "military_capacity",
  "economic_control",
  "information_control",
  "international_support",
  "internal_legitimacy",
] as const

type AxisKey = typeof AXIS_KEYS[number]

interface AxisScore {
  score: number
  evidence: string
}

export function computePentagonScore(factors: Record<string, number>): number {
  const s = AXIS_KEYS.map(k => Math.max(0, Math.min(100, factors[k] ?? 0)))
  const sin72 = Math.sin((2 * Math.PI) / 5)
  let area = 0
  for (let i = 0; i < 5; i++) {
    area += s[i] * s[(i + 1) % 5]
  }
  area *= 0.5 * sin72
  const maxArea = 0.5 * sin72 * 5 * 100 * 100
  return Math.round(100 * area / maxArea)
}

export async function scoreOneParty(
  topicId: string,
  title: string,
  description: string,
  party: Party,
  model: string,
): Promise<{ factors: Party["weight_factors"]; evidence: Record<string, string>; overall: number }> {
  const today = new Date().toISOString().slice(0, 10)
  const year = new Date().getFullYear().toString()

  const partyProfile = JSON.stringify({
    id: party.id,
    name: party.name,
    type: party.type,
    description: party.description,
    agenda: party.agenda,
    means: party.means,
    circle: party.circle,
  }, null, 2)

  const config = await resolvePrompt("discovery/score-axes", {
    today,
    year,
    topic: title,
    description,
    party_profile: partyProfile,
  })
  const effectiveModel = config.model ?? model

  log.discovery(`PartyScorer: scoring "${party.name}" with ${effectiveModel}`)
  emitThink(topicId, "📊", `Scoring: ${party.name}`, "Researching 5 power axes…")

  const controls = dbGetControls()
  const raw = await runAgenticLoop({
    model: effectiveModel,
    topicId,
    stage: "scoring",
    tools: config.tools,
    maxIterations: controls.scoring_iterations,
    temperature: 0.2,
    max_tokens: budgetOutput(effectiveModel, config.content, { min: 2000, max: 4000 }),
    contextWarningThreshold: controls.scoring_context_warning,
    messages: [
      { role: "system", content: config.content },
      { role: "user", content: `Begin your research on ${party.name}. Search for specific metrics and data for each of the 5 dimensions. Output your scores as JSON when done.` },
    ],
  })

  const match = raw.match(/\{[\s\S]+\}/)
  if (!match) throw new Error(`PartyScorer: failed to parse output for ${party.name}`)

  const parsed = JSON.parse(match[0]) as { scores: Record<AxisKey, AxisScore> }
  const scores = parsed.scores

  const factors: Party["weight_factors"] = {
    military_capacity: 0,
    economic_control: 0,
    information_control: 0,
    international_support: 0,
    internal_legitimacy: 0,
  }
  const evidence: Record<string, string> = {}

  for (const key of AXIS_KEYS) {
    const entry = scores[key]
    if (entry) {
      factors[key] = Math.max(0, Math.min(100, Math.round(entry.score)))
      evidence[key] = entry.evidence ?? ""
    }
  }

  const overall = computePentagonScore(factors)

  log.discovery(`PartyScorer: ${party.name} → overall=${overall} [${AXIS_KEYS.map(k => `${k.slice(0, 3)}=${factors[k]}`).join(", ")}]`)
  emitThink(topicId, "✅", `Scored: ${party.name}`, `Overall ${overall} · mil=${factors.military_capacity} eco=${factors.economic_control} info=${factors.information_control} intl=${factors.international_support} legit=${factors.internal_legitimacy}`)

  return { factors, evidence, overall }
}

export async function scoreAllParties(
  topicId: string,
  title: string,
  description: string,
  parties: Party[],
  model: string,
): Promise<Party[]> {
  log.discovery(`PartyScorer: scoring ${parties.length} parties`)
  emitThink(topicId, "📊", "Scoring party power axes", `${parties.length} parties × 5 axes with evidence`)

  const controls = dbGetControls()
  const BATCH = controls.scoring_batch_size
  for (let i = 0; i < parties.length; i += BATCH) {
    const batch = parties.slice(i, i + BATCH)
    emitThink(topicId, "📊", `Scoring batch ${Math.floor(i / BATCH) + 1}`, batch.map(p => p.name).join(", "))

    const results = await Promise.all(batch.map(async (party) => {
      try {
        return await scoreOneParty(topicId, title, description, party, model)
      } catch (e) {
        log.error("DISCOVERY", `PartyScorer failed for ${party.name}: ${e}`)
        emitThink(topicId, "⚠", `Scoring failed: ${party.name}`, String(e))
        return null
      }
    }))

    for (let j = 0; j < batch.length; j++) {
      const result = results[j]
      if (result) {
        batch[j].weight_factors = result.factors
        batch[j].weight = result.overall
        batch[j].weight_evidence = result.evidence
      }
    }
  }

  log.discovery(`PartyScorer: complete. Scores: ${parties.map(p => `${p.name}=${p.weight}`).join(", ")}`)
  return parties
}

export async function rescoreParty(
  topicId: string,
  title: string,
  description: string,
  party: Party,
  model: string,
): Promise<Party> {
  const { factors, evidence, overall } = await scoreOneParty(topicId, title, description, party, model)
  return { ...party, weight_factors: factors, weight_evidence: evidence, weight: overall }
}

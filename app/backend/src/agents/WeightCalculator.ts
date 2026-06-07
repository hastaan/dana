import { chatCompletionText } from "../llm/proxyClient"
import { runAgenticLoop } from "../llm/agenticLoop"
import { dbGetControls } from "../db/queries/settings"
import { resolvePrompt } from "../llm/promptLoader"
import { writeArtifact } from "../tools/internal/artifactStore"
import { emitThink } from "../routes/stream"
import { log } from "../utils/logger"
import { dbGetParties, dbSetParties } from "../db/queries/parties"
import { dbSetRepresentatives } from "../db/queries/forum"
import type { Party } from "./DiscoveryAgent"

export interface SpeakingBudget {
  opening_statement: number
  rebuttal: number
  closing: number
  minimum_floor: number
}

export interface Representative {
  id: string
  party_id: string
  persona_prompt: string
  persona_title: string
  speaking_weight: number
  speaking_budget: SpeakingBudget
  auto_generated: true
}

export interface ForumPrepOutput {
  topic_id: string
  run_id: string
  representatives: { party_id: string; persona_title: string; speaking_weight: number }[]
}

const LOW_WEIGHT_THRESHOLD = 15

function computeSpeakingBudget(weight: number, totalWeight: number, isLowWeight: boolean): SpeakingBudget {
  const controls = dbGetControls()
  const ROUND_POOLS = { opening: controls.forum_speaking_budget, rebuttal: Math.round(controls.forum_speaking_budget * 0.67), closing: Math.round(controls.forum_speaking_budget * 0.5) }
  const MIN_FLOOR = 150
  if (isLowWeight) {
    return { opening_statement: MIN_FLOOR, rebuttal: MIN_FLOOR, closing: MIN_FLOOR, minimum_floor: MIN_FLOOR }
  }
  const ratio = weight / totalWeight
  return {
    opening_statement: Math.max(MIN_FLOOR, Math.round(ratio * ROUND_POOLS.opening)),
    rebuttal: Math.max(MIN_FLOOR, Math.round(ratio * ROUND_POOLS.rebuttal)),
    closing: Math.max(MIN_FLOOR, Math.round(ratio * ROUND_POOLS.closing)),
    minimum_floor: MIN_FLOOR,
  }
}

export async function runForumPrep(
  topicId: string,
  title: string,
  model: string,
  runId: string,
  onProgress?: (msg: string) => void
): Promise<ForumPrepOutput> {
  const personaConfig = await resolvePrompt("weight/persona-generation")
  const personaModel = personaConfig.model ?? model

  const parties = dbGetParties(topicId)
  const totalWeight = parties.reduce((sum, p) => sum + (p.weight ?? 0), 0)

  log.weight(`Forum prep: generating personas for ${parties.length} parties (total weight ${totalWeight})`)
  onProgress?.(`Forum prep: generating ${parties.length} representative personas`)
  emitThink(topicId, "🎭", "Generating forum representatives", `${parties.length} parties`)

  const representatives: Representative[] = []
  const PERSONA_BATCH = 4

  for (let bi = 0; bi < parties.length; bi += PERSONA_BATCH) {
    const batch = parties.slice(bi, bi + PERSONA_BATCH)
    onProgress?.(`Forum prep: personas ${bi + 1}-${Math.min(bi + PERSONA_BATCH, parties.length)} of ${parties.length}`)

    const batchResults = await Promise.all(batch.map(async (party) => {
      const personaInput = `PARTY: ${party.name}\nTYPE: ${party.type}\nAGENDA: ${party.agenda}\nMEANS: ${party.means.join(", ")}\nSTANCE: ${party.stance}\nTOPIC: ${title}`
      let personaRaw: string
      if (personaConfig.tools.length > 0) {
        personaRaw = await runAgenticLoop({
          model: personaModel,
          messages: [
            { role: "system", content: personaConfig.content },
            { role: "user", content: personaInput },
          ],
          tools: personaConfig.tools,
          topicId,
          stage: "forum_prep",
          temperature: 0.4,
          max_tokens: 400,
        })
      } else {
        personaRaw = await chatCompletionText({
          model: personaModel,
          messages: [
            { role: "system", content: personaConfig.content },
            { role: "user", content: personaInput },
          ],
          temperature: 0.4,
          max_tokens: 400,
        })
      }

      let personaTitle = party.name + " Representative"
      let personaPrompt = personaRaw.trim()

      try {
        const match = personaRaw.match(/\{[\s\S]+\}/)
        if (match) {
          const parsed = JSON.parse(match[0])
          personaTitle = parsed.title || personaTitle
          personaPrompt = parsed.prompt || personaPrompt
        }
      } catch { /* use raw */ }

      const isLowWeight = (party.weight ?? 0) < LOW_WEIGHT_THRESHOLD
      const budget = computeSpeakingBudget(party.weight ?? 0, totalWeight, isLowWeight)

      const rep: Representative = {
        id: `rep-${party.id}`,
        party_id: party.id,
        persona_prompt: personaPrompt,
        persona_title: personaTitle,
        speaking_weight: party.weight ?? 0,
        speaking_budget: budget,
        auto_generated: true,
      }

      emitThink(topicId, "🎭", `Representative created · ${party.name}`, `${personaTitle} · weight ${party.weight}`)
      return rep
    }))

    representatives.push(...batchResults)
  }

  dbSetRepresentatives(topicId, representatives)

  const output: ForumPrepOutput = {
    topic_id: topicId,
    run_id: runId,
    representatives: representatives.map(r => ({ party_id: r.party_id, persona_title: r.persona_title, speaking_weight: r.speaking_weight })),
  }

  await writeArtifact(topicId, runId, "forum_prep", output)
  log.weight(`Forum prep complete: ${representatives.map(r => `${r.party_id}=${r.speaking_weight}w (opening=${r.speaking_budget.opening_statement}w)`).join(", ")}`)
  onProgress?.(`Forum prep: done. ${representatives.length} representatives created`)
  return output
}

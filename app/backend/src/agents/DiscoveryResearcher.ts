import { resolvePrompt } from "../llm/promptLoader"
import { runAgenticLoop } from "../llm/agenticLoop"
import { dbGetControls } from "../db/queries/settings"
import { budgetOutput } from "../llm/tokenBudget"
import { emitThink } from "../routes/stream"
import { log } from "../utils/logger"
import type { Party } from "./DiscoveryAgent"

interface OrientationOutput {
  angles: string[]
  likely_party_types: string[]
  seed_queries: string[]
}

interface ResearchSource {
  url: string
  title: string
  used_for: string
}

export interface DiscoveryResearchResult {
  parties: Party[]
  sources: ResearchSource[]
}

export async function runDiscoveryResearcher(
  topicId: string,
  title: string,
  description: string,
  model: string,
  orientation: OrientationOutput,
): Promise<DiscoveryResearchResult> {
  const today = new Date().toISOString().slice(0, 10)
  const year = new Date().getFullYear().toString()

  log.discovery(`DiscoveryResearcher: starting agentic research for "${title}"`)
  emitThink(topicId, "🔬", "Agentic research started", `${orientation.angles.length} angles, ${orientation.seed_queries.length} seed queries`)

  const config = await resolvePrompt("discovery/agentic-research", {
    today,
    year,
    title,
    description,
    angles: orientation.angles.map((a, i) => `${i + 1}. ${a}`).join("\n"),
    party_types: orientation.likely_party_types.join(", "),
    seed_queries: orientation.seed_queries.map((q, i) => `${i + 1}. ${q}`).join("\n"),
  })
  const effectiveModel = config.model ?? model

  const userMessage = `Begin your research. Start with the seed queries, then go deeper based on what you find. Output your final results as JSON when done.`

  const controls = dbGetControls()
  const raw = await runAgenticLoop({
    model: effectiveModel,
    topicId,
    stage: "discovery",
    tools: config.tools,
    maxIterations: controls.discovery_research_iterations,
    temperature: 0.3,
    max_tokens: budgetOutput(effectiveModel, config.content + userMessage, { min: 8000, max: 16000 }),
    contextWarningThreshold: controls.discovery_context_warning,
    messages: [
      { role: "system", content: config.content },
      { role: "user", content: userMessage },
    ],
  })

  const match = raw.match(/\{[\s\S]+\}/)
  if (!match) {
    log.discovery("DiscoveryResearcher: failed to parse JSON from output")
    throw new Error("Failed to parse research output JSON")
  }

  const result = JSON.parse(match[0]) as DiscoveryResearchResult

  const parties: Party[] = (result.parties ?? []).map(p => ({
    ...p,
    id: p.id || p.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30),
    auto_discovered: true,
    user_verified: false,
  }))

  log.discovery(`DiscoveryResearcher: found ${parties.length} parties, ${(result.sources ?? []).length} sources`)
  emitThink(topicId, "✅", "Research complete", `${parties.length} parties identified from ${(result.sources ?? []).length} sources`)

  for (const p of parties) {
    emitThink(topicId, "🧩", `Party: ${p.name}`, `${p.type.replace(/_/g, " ")} · weight ${p.weight}`)
    await new Promise(r => setTimeout(r, 150))
  }

  return { parties, sources: result.sources ?? [] }
}

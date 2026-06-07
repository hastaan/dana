import { resolvePrompt } from "../llm/promptLoader"
import { runAgenticLoop } from "../llm/agenticLoop"
import { dbGetControls } from "../db/queries/settings"
import { RESEARCH_TOOLS } from "../llm/toolDefinitions"
import { budgetOutput } from "../llm/tokenBudget"
import { dbUpdateClueVersion, dbGetClue } from "../db/queries/clues"
import type { FactCheckResult } from "../db/queries/clues"
import { getDb } from "../db/database"
import { log } from "../utils/logger"
import { steeringBlock } from "../llm/steering"

export interface FactCheckInput {
  topicId: string
  clueId: string
  title: string
  summary: string
  sourceUrls: string[]
  sourceOutlets: string[]
  keyPoints: string[]
  biasFlags: string[]
  credibility: number
  partyContext: string
  topicTitle: string
  topicDescription: string
  model: string
  maxIterations?: number
}

export interface FactCheckVerdict {
  verdict: FactCheckResult["verdict"]
  bias_analysis: string
  counter_evidence: string
  cui_bono: string
  adjusted_credibility: number
  adjusted_bias_flags: string[]
}

const DEFAULT_VERDICT: FactCheckVerdict = {
  verdict: "unverifiable",
  bias_analysis: "Fact-check could not complete",
  counter_evidence: "",
  cui_bono: "",
  adjusted_credibility: 50,
  adjusted_bias_flags: [],
}

export async function runFactCheck(input: FactCheckInput): Promise<FactCheckVerdict> {
  const today = new Date().toISOString().slice(0, 10)
  const year = new Date().getFullYear().toString()
  const controls = dbGetControls()

  const config = await resolvePrompt("enrichment/fact-check", {
    today,
    year,
    title: input.topicTitle,
    description: input.topicDescription,
    clue_title: input.title,
    clue_summary: input.summary,
    source_urls: input.sourceUrls.join("\n") || "none",
    source_outlets: input.sourceOutlets.join(", ") || "unknown",
    key_points: input.keyPoints.join("\n") || "none",
    credibility: String(input.credibility),
    bias_flags: input.biasFlags.join(", ") || "none",
    party_context: input.partyContext,
    clue_date: today,
  })

  const effectiveModel = config.model ?? input.model

  const raw = await runAgenticLoop({
    model: effectiveModel,
    topicId: input.topicId,
    stage: "fact-check",
    tools: RESEARCH_TOOLS,
    maxIterations: input.maxIterations ?? controls.fact_check_iterations,
    temperature: 0.2,
    max_tokens: budgetOutput(effectiveModel, config.content, { min: 1500, max: 3000 }),
    contextWarningThreshold: 80000,
    messages: [
      { role: "system", content: config.content + steeringBlock(input.topicId, "evidence") },
      { role: "user", content: `Fact-check this clue now. Use tools to verify, then output your verdict as JSON.` },
    ],
  })

  let verdict: FactCheckVerdict = { ...DEFAULT_VERDICT }

  try {
    const match = raw.match(/\{[\s\S]+\}/)
    if (match) {
      const parsed = JSON.parse(match[0])
      verdict = {
        verdict: parsed.verdict ?? "unverifiable",
        bias_analysis: String(parsed.bias_analysis ?? ""),
        counter_evidence: String(parsed.counter_evidence ?? ""),
        cui_bono: String(parsed.cui_bono ?? ""),
        adjusted_credibility: Number(parsed.adjusted_credibility ?? input.credibility),
        adjusted_bias_flags: (parsed.adjusted_bias_flags as string[]) ?? input.biasFlags,
      }
    }
  } catch (e) {
    log.enrichment(`FactCheckAgent: failed to parse verdict for ${input.clueId}: ${e}`)
  }

  // Update the clue in DB with the fact-check result
  try {
    const factCheckResult: FactCheckResult = {
      verdict: verdict.verdict,
      bias_analysis: verdict.bias_analysis,
      counter_evidence: verdict.counter_evidence,
      cui_bono: verdict.cui_bono,
      adjusted_credibility: verdict.adjusted_credibility,
      adjusted_bias_flags: verdict.adjusted_bias_flags,
      checked_at: new Date().toISOString(),
    }

    const clue = dbGetClue(input.topicId, input.clueId)
    if (clue) {
      const cur = clue.versions.find(v => v.v === clue.current)
      if (cur) {
        dbUpdateClueVersion(input.topicId, input.clueId, {
          fact_check: factCheckResult,
          source_credibility: {
            ...cur.source_credibility,
            score: verdict.adjusted_credibility,
            bias_flags: verdict.adjusted_bias_flags,
          },
        })
      }
    }

    // Update clue status based on verdict
    const statusMap: Record<string, string> = {
      verified: "verified",
      disputed: "disputed",
      misleading: "disputed",
      unverifiable: "pending",
    }
    const newStatus = statusMap[verdict.verdict] ?? "pending"
    getDb().run(
      "UPDATE clues SET status = ?, last_updated_at = ? WHERE id = ? AND topic_id = ?",
      [newStatus, new Date().toISOString(), input.clueId, input.topicId]
    )
  } catch (e) {
    log.enrichment(`FactCheckAgent: failed to update clue ${input.clueId}: ${e}`)
  }

  return verdict
}

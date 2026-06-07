import { runAgenticLoop } from "../llm/agenticLoop"
import { dbGetControls } from "../db/queries/settings"
import { RESEARCH_TOOLS } from "../llm/toolDefinitions"
import { budgetOutput } from "../llm/tokenBudget"
import { resolvePrompt } from "../llm/promptLoader"
import { dbAddClueVersion } from "../db/queries/clues"
import { emitThink, emit } from "../routes/stream"
import { log } from "../utils/logger"
import { runFactCheck } from "./FactCheckAgent"
import type { Clue } from "../db/queries/clues"
import type { Party } from "./DiscoveryAgent"

export interface EvidenceUpdateResult {
  checked: number
  updated: number
  unchanged: number
}

export async function runEvidenceUpdateAgent(
  topicId: string,
  title: string,
  description: string,
  clues: Clue[],
  parties: Party[],
  model: string,
): Promise<EvidenceUpdateResult> {
  const today = new Date().toISOString().slice(0, 10)
  const year = new Date().getFullYear().toString()
  const controls = dbGetControls()

  const partyList = parties.map(p => `${p.id}: ${p.name}`).join("\n") || "No parties defined."

  log.enrichment(`EvidenceUpdateAgent: checking ${clues.length} clues for updates`)
  emitThink(topicId, "🔄", `Checking ${clues.length} clues for updates`, today)

  const result: EvidenceUpdateResult = { checked: 0, updated: 0, unchanged: 0 }

  const BATCH = controls.evidence_update_batch_size
  for (let bi = 0; bi < clues.length; bi += BATCH) {
    const batch = clues.slice(bi, bi + BATCH)

    await Promise.all(batch.map(async (clue) => {
      const cur = clue.versions.find(v => v.v === clue.current)
      if (!cur) return

      const clueDate = cur.timeline_date || "unknown"
      const clueTitle = cur.title
      const clueSummary = cur.bias_corrected_summary
      const clueSourceUrls = cur.raw_source?.urls ?? []
      const clueSourceOutlets = cur.raw_source?.outlets ?? []

      emitThink(topicId, "🔍", `Checking: ${clueTitle.slice(0, 60)}`, `Original date: ${clueDate}`)
      result.checked++

      try {
        const config = await resolvePrompt("clue-extractor/update-clue", {
          today, year, title, description,
          party_list: partyList,
          clue_id: clue.id,
          clue_title: clueTitle,
          clue_date: clueDate,
          clue_summary: clueSummary,
          clue_sources: clueSourceUrls.join(", ") || "none",
        })
        const effectiveModel = config.model ?? model

        const raw = await runAgenticLoop({
          model: effectiveModel,
          topicId,
          stage: "enrichment",
          tools: RESEARCH_TOOLS,
          maxIterations: controls.evidence_update_iterations,
          temperature: 0.2,
          max_tokens: budgetOutput(effectiveModel, config.content, { min: 1000, max: 3000 }),
          messages: [
            { role: "system", content: config.content },
            { role: "user", content: `Check for updates to this clue since ${clueDate}. Search now and output your JSON verdict.` },
          ],
        })

        const match = raw.match(/\{[\s\S]+\}/)
        if (!match) {
          result.unchanged++
          emitThink(topicId, "⏭️", `No update: ${clueTitle.slice(0, 50)}`, "Could not parse response")
          return
        }

        const verdict = JSON.parse(match[0]) as {
          has_update: boolean
          updated_title?: string
          updated_summary?: string
          updated_date?: string
          updated_clue_type?: string
          new_source_urls?: string[]
          new_source_outlets?: string[]
          credibility?: number
          bias_flags?: string[]
          key_points?: string[]
          update_note?: string
        }

        if (!verdict.has_update) {
          result.unchanged++
          emitThink(topicId, "✓", `No updates: ${clueTitle.slice(0, 50)}`, "Up to date")
          return
        }

        const newVersionNum = clue.versions.length + 1
        const now = new Date().toISOString()
        const newUrls = verdict.new_source_urls ?? clueSourceUrls
        const newOutlets = verdict.new_source_outlets ?? clueSourceOutlets

        dbAddClueVersion(topicId, clue.id, {
          v: newVersionNum,
          date: now,
          title: verdict.updated_title || clueTitle,
          raw_source: { urls: newUrls, outlets: newOutlets, fetched_at: now },
          source_credibility: {
            score: verdict.credibility ?? cur.source_credibility.score,
            notes: `Updated: ${verdict.update_note ?? "new information found"}`,
            bias_flags: verdict.bias_flags ?? cur.source_credibility.bias_flags,
            origin_sources: newUrls.map((url, i) => ({
              url, outlet: newOutlets[i] ?? url, is_republication: false,
            })),
          },
          bias_corrected_summary: verdict.updated_summary || clueSummary,
          relevance_score: cur.relevance_score,
          party_relevance: cur.party_relevance,
          domain_tags: cur.domain_tags,
          timeline_date: verdict.updated_date || clueDate,
          clue_type: verdict.updated_clue_type || cur.clue_type,
          change_note: verdict.update_note || "Evidence update",
          key_points: verdict.key_points ?? cur.key_points,
        })

        result.updated++
        emitThink(topicId, "🔄", `Updated: ${clueTitle.slice(0, 50)}`, verdict.update_note?.slice(0, 80) ?? "")

        try {
          const factVerdict = await runFactCheck({
            topicId, clueId: clue.id,
            title: verdict.updated_title || clueTitle,
            summary: verdict.updated_summary || clueSummary,
            sourceUrls: newUrls, sourceOutlets: newOutlets,
            keyPoints: verdict.key_points ?? [],
            biasFlags: verdict.bias_flags ?? [],
            credibility: verdict.credibility ?? cur.source_credibility.score,
            partyContext: cur.party_relevance.join(", "),
            topicTitle: title, topicDescription: description, model: effectiveModel,
          })
          emitThink(topicId,
            factVerdict.verdict === "verified" ? "✅" : factVerdict.verdict === "disputed" ? "🔶" : "⚠️",
            `${factVerdict.verdict.toUpperCase()}: ${(verdict.updated_title || clueTitle).slice(0, 50)}`,
            factVerdict.bias_analysis.slice(0, 100))
        } catch {
          // fact-check failure is non-fatal
        }
      } catch (err) {
        log.error("EVIDENCE_UPDATE", `Failed for clue ${clue.id}: ${err}`)
        result.unchanged++
      }
    }))
  }

  log.enrichment(`EvidenceUpdateAgent: done — ${result.updated} updated, ${result.unchanged} unchanged out of ${result.checked} checked`)
  emitThink(topicId, "✅", "Evidence update complete", `${result.updated} updated · ${result.unchanged} unchanged`)
  emit(topicId, { type: "stage_complete", stage: "evidence_update" })
  return result
}

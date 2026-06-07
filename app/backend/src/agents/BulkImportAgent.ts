import { runAgenticLoop, type CustomToolHandler } from "../llm/agenticLoop"
import { dbGetControls } from "../db/queries/settings"
import { TOOL_REGISTRY } from "../llm/toolDefinitions"
import { budgetOutput } from "../llm/tokenBudget"
import { resolvePrompt } from "../llm/promptLoader"
import { storeClue } from "../tools/processing/storeClue"
import { dbGetClue, dbAddClueVersion, dbUpdateClueVersion, dbGetClueIndex } from "../db/queries/clues"
import { emitThink, emit } from "../routes/stream"
import { log } from "../utils/logger"
import { runFactCheck } from "./FactCheckAgent"
import type { Party } from "./DiscoveryAgent"

export interface BulkImportResult {
  stored: number
  updated: number
  skipped: number
  chunks: number
}

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, "") } catch { return url }
}

function smartChunk(content: string, targetChars = 2000, maxChars = 4000): string[] {
  const raw = content
    .split(/\n{2,}|\n(?=\*\s|\-\s|\d{4}[-\/]\d{2}|#{1,3}\s|Mar |Feb |Jan |Apr |May |Jun |Jul |Aug |Sep |Oct |Nov |Dec )/)
    .map(s => s.trim()).filter(s => s.length > 20)
  const chunks: string[] = []
  let current = ""
  for (const block of raw) {
    if (!current) {
      current = block
    } else if (current.length + block.length + 2 <= maxChars) {
      current += "\n\n" + block
      if (current.length >= targetChars) { chunks.push(current); current = "" }
    } else {
      chunks.push(current); current = block
    }
  }
  if (current) chunks.push(current)
  return chunks
}

export async function runBulkImportAgent(
  topicId: string,
  title: string,
  description: string,
  content: string,
  parties: Party[],
  model: string,
): Promise<BulkImportResult> {
  const today = new Date().toISOString().slice(0, 10)
  const year = new Date().getFullYear().toString()
  const controls = dbGetControls()

  const partyList = parties.map(p => `${p.id}: ${p.name}`).join("\n") || "No parties defined yet."

  const existingIndex = dbGetClueIndex(topicId)
  const existingCluesSummary = existingIndex.length > 0
    ? existingIndex.map(c => `[${c.id}] "${c.title}" (${c.timeline_date}, rel=${c.relevance_score}) — check before creating similar clue`).join("\n")
    : "No existing clues."

  const chunks = smartChunk(content, controls.bulk_import_chunk_target_chars, controls.bulk_import_chunk_max_chars)
  log.enrichment(`BulkImportAgent: ${chunks.length} chunks from ${content.length} chars`)
  emitThink(topicId, "📋", `Bulk import: ${chunks.length} chunks to process`, `${content.length} chars input`)

  const result: BulkImportResult = { stored: 0, updated: 0, skipped: 0, chunks: chunks.length }

  const config = await resolvePrompt("clue-extractor/bulk-import", {
    today, year, title, description, party_list: partyList, existing_clues: existingCluesSummary,
  })
  const effectiveModel = config.model ?? model

  const storeClueToolDef = TOOL_REGISTRY["store_clue"]
  const effectiveTools = [
    ...config.tools,
    ...(storeClueToolDef && !config.tools.some(t => t.function.name === "store_clue") ? [storeClueToolDef] : []),
  ]

  await Promise.all(chunks.map(async (chunk, offset) => {
      const idx = offset + 1
      emitThink(topicId, "📋", `Processing chunk ${idx}/${chunks.length}`, chunk.slice(0, 80))

      const storedIds: string[] = []
      let updatedCount = 0

      const storeClueHandler: CustomToolHandler = async (args) => {
        try {
          const sourceUrls = (args.source_urls as string[]) ?? []
          const sourceOutlets = (args.source_outlets as string[]) ?? sourceUrls.map(u => domainOf(u))
          const updatesClueId = args.updates_clue_id as string | undefined

          if (updatesClueId) {
            // Add a new version to an existing clue
            const existing = dbGetClue(topicId, updatesClueId)
            if (!existing) return JSON.stringify({ error: `Clue ${updatesClueId} not found` })

            const newVersionNum = existing.versions.length + 1
            const now = new Date().toISOString()
            const newVersion = {
              v: newVersionNum,
              date: now,
              title: String(args.title ?? ""),
              raw_source: { urls: sourceUrls, outlets: sourceOutlets, fetched_at: now },
              source_credibility: {
                score: Number(args.credibility ?? 50),
                notes: `Updated via bulk import. Sources: ${sourceOutlets.join(", ")}`,
                bias_flags: (args.bias_flags as string[]) ?? [],
                origin_sources: sourceUrls.map((url, i) => ({
                  url, outlet: sourceOutlets[i] ?? domainOf(url), is_republication: false,
                })),
              },
              bias_corrected_summary: String(args.summary ?? ""),
              relevance_score: Number(args.relevance ?? 50),
              party_relevance: (args.parties as string[]) ?? [],
              domain_tags: (args.domain_tags as string[]) ?? [],
              timeline_date: String(args.date ?? today),
              clue_type: String(args.clue_type ?? "event"),
              change_note: `Bulk import update: new information found`,
              key_points: (args.key_points as string[]) ?? [],
            }

            dbAddClueVersion(topicId, updatesClueId, newVersion)
            updatedCount++
            emitThink(topicId, "🔄", `Updated: ${String(args.title ?? "").slice(0, 50)}`, `v${newVersionNum} of ${updatesClueId}`)

            try {
              const verdict = await runFactCheck({
                topicId, clueId: updatesClueId,
                title: String(args.title ?? ""), summary: String(args.summary ?? ""),
                sourceUrls, sourceOutlets,
                keyPoints: (args.key_points as string[]) ?? [],
                biasFlags: (args.bias_flags as string[]) ?? [],
                credibility: Number(args.credibility ?? 50),
                partyContext: ((args.parties as string[]) ?? []).join(", "),
                topicTitle: title, topicDescription: description, model: effectiveModel,
                maxIterations: controls.bulk_fact_check_iterations,
              })
              emitThink(topicId, verdict.verdict === "verified" ? "✅" : "🔶",
                `${verdict.verdict.toUpperCase()}: ${String(args.title ?? "").slice(0, 50)}`,
                verdict.bias_analysis.slice(0, 100))
              return JSON.stringify({ status: "updated", clue_id: updatesClueId, version: newVersionNum, fact_check: verdict.verdict })
            } catch {
              return JSON.stringify({ status: "updated", clue_id: updatesClueId, version: newVersionNum, fact_check: "skipped" })
            }
          }

          // New clue
          const storeResult = await storeClue({
            topicId,
            title: String(args.title ?? ""),
            sourceUrls, sourceOutlets,
            fetchedAt: new Date().toISOString(),
            processed: {
              extracted_content: "",
              bias_corrected_summary: String(args.summary ?? ""),
              bias_flags: (args.bias_flags as string[]) ?? [],
              source_credibility_score: Number(args.credibility ?? 50),
              credibility_notes: `Sources: ${sourceOutlets.join(", ")}`,
              origin_sources: sourceUrls.map((url, i) => ({
                url, outlet: sourceOutlets[i] ?? domainOf(url), is_republication: false,
              })),
              key_points: (args.key_points as string[]) ?? [],
              date_references: [String(args.date ?? today)],
              relevance_score: Number(args.relevance ?? 50),
            },
            partyRelevance: (args.parties as string[]) ?? [],
            domainTags: (args.domain_tags as string[]) ?? [],
            timelineDate: String(args.date ?? today),
            clueType: String(args.clue_type ?? "event"),
            addedBy: "user",
            changeNote: "Bulk import",
            initialStatus: "pending",
          })

          if (storeResult.status === "duplicate") {
            result.skipped++
            return JSON.stringify({ status: "duplicate", clue_id: storeResult.clue_id, message: "Already exists" })
          }

          storedIds.push(storeResult.clue_id)
          emitThink(topicId, "📌", `Stored: ${String(args.title ?? "").slice(0, 50)}`, `${storeResult.clue_id}`)

          try {
            const verdict = await runFactCheck({
              topicId, clueId: storeResult.clue_id,
              title: String(args.title ?? ""), summary: String(args.summary ?? ""),
              sourceUrls, sourceOutlets,
              keyPoints: (args.key_points as string[]) ?? [],
              biasFlags: (args.bias_flags as string[]) ?? [],
              credibility: Number(args.credibility ?? 50),
              partyContext: ((args.parties as string[]) ?? []).join(", "),
              topicTitle: title, topicDescription: description, model: effectiveModel,
              maxIterations: controls.bulk_fact_check_iterations,
            })
            emitThink(topicId, verdict.verdict === "verified" ? "✅" : verdict.verdict === "disputed" ? "🔶" : "⚠️",
              `${verdict.verdict.toUpperCase()}: ${String(args.title ?? "").slice(0, 50)}`,
              verdict.bias_analysis.slice(0, 100))
            return JSON.stringify({ status: "created", clue_id: storeResult.clue_id, fact_check: verdict.verdict })
          } catch {
            return JSON.stringify({ status: "created", clue_id: storeResult.clue_id, fact_check: "skipped" })
          }
        } catch (err) {
          return JSON.stringify({ error: String(err) })
        }
      }

      await runAgenticLoop({
        model: effectiveModel,
        topicId,
        stage: "enrichment",
        tools: effectiveTools,
        maxIterations: controls.bulk_import_iterations,
        temperature: 0.2,
        max_tokens: budgetOutput(effectiveModel, config.content + chunk, { min: 2000, max: 6000 }),
        customTools: { store_clue: storeClueHandler },
        freeTools: ["store_clue"],
        perRoundCaps: {
          web_search: controls.enrichment_max_searches_per_round,
          fetch_url: controls.enrichment_max_fetches_per_round,
        },
        messages: [
          { role: "system", content: config.content },
          { role: "user", content: `Process this content chunk and extract verified clues:\n\n${chunk}` },
        ],
      })

      result.stored += storedIds.length
      result.updated += updatedCount
  }))

  log.enrichment(`BulkImportAgent: done — ${result.stored} stored, ${result.updated} updated, ${result.skipped} skipped`)
  emitThink(topicId, "✅", "Bulk import complete", `${result.stored} new · ${result.updated} updated · ${result.skipped} skipped`)
  emit(topicId, { type: "stage_complete", stage: "bulk_import" })
  return result
}

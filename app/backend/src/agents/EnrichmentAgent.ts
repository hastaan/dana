import { writeArtifact } from "../tools/internal/artifactStore"
import { dbGetControls } from "../db/queries/settings"
import { log } from "../utils/logger"
import { dbCountClues, dbGetClues } from "../db/queries/clues"
import { dbGetParties, dbSetParties } from "../db/queries/parties"
import { emit } from "../routes/stream"
import { runPartyEnrichmentAgent } from "./PartyEnrichmentAgent"
import type { Party } from "./DiscoveryAgent"

export interface EnrichmentOutput {
  topic_id: string
  run_id: string
  enriched_party_ids: string[]
  clue_ids: string[]
  fact_check: { verified: number; disputed: number; misleading: number; skipped: number }
  total_clues_after: number
}

export async function runEnrichmentAgent(
  topicId: string,
  title: string,
  description: string,
  models: { enrichment: string; extraction: string },
  runId: string,
  onProgress?: (msg: string) => void
): Promise<EnrichmentOutput> {
  log.separator()
  log.enrichment(`Starting enrichment for "${title}"`)
  log.enrichment(`Model: ${models.enrichment}`)
  log.separator()

  const parties = dbGetParties(topicId)
  const allClueIds: string[] = []
  const enrichedPartyIds: string[] = []
  const factCheckTotals = { verified: 0, disputed: 0, misleading: 0, skipped: 0 }

  emit(topicId, { type: "progress", stage: "enrichment", pct: 0.05, msg: `Enriching ${parties.length} parties with agentic research…` })

  // Run per-party enrichment agents in batches
  const controls = dbGetControls()
  const BATCH = controls.enrichment_batch_size
  for (let i = 0; i < parties.length; i += BATCH) {
    const batch = parties.slice(i, i + BATCH)
    const pct = 0.1 + (i / parties.length) * 0.8

    emit(topicId, { type: "progress", stage: "enrichment", pct, msg: `Researching: ${batch.map(p => p.name).join(", ")}` })
    onProgress?.(`Enriching: ${batch.map(p => p.name).join(", ")}`)

    const results = await Promise.all(batch.map(async (party) => {
      const existingClues = getExistingCluesForParty(topicId, party.id)
      return runPartyEnrichmentAgent(
        topicId, title, description, party, existingClues, models.enrichment,
      )
    }))

    for (const result of results) {
      allClueIds.push(...result.storedClueIds)

      if (result.profileUpdate) {
        const party = parties.find(p => p.id === result.partyId)
        if (party) {
          Object.assign(party, result.profileUpdate)
          enrichedPartyIds.push(result.partyId)
          log.enrichment(`Profile updated: ${party.name}`)
        }
      }
    }
  }

  // Save enriched party profiles back to DB
  dbSetParties(topicId, parties)

  // Tally fact-check verdicts from the DB (set by FactCheckAgent inline during enrichment)
  const allClues = dbGetClues(topicId)
  for (const c of allClues) {
    const cur = c.versions.find(v => v.v === c.current)
    if (!cur?.fact_check) { factCheckTotals.skipped++; continue }
    const v = cur.fact_check.verdict
    if (v === "verified") factCheckTotals.verified++
    else if (v === "disputed") factCheckTotals.disputed++
    else if (v === "misleading") factCheckTotals.misleading++
    else factCheckTotals.skipped++
  }

  const totalCluesAfter = dbCountClues(topicId)

  emit(topicId, { type: "progress", stage: "enrichment", pct: 1.0, msg: "Enrichment complete" })
  onProgress?.(`Enrichment complete: ${allClueIds.length} clues, ${enrichedPartyIds.length} profiles updated`)

  log.separator()
  log.enrichment(`Enrichment COMPLETE: ${allClueIds.length} clues stored, ${enrichedPartyIds.length} profiles enriched, ${totalCluesAfter} total in DB`)
  log.separator()

  const output: EnrichmentOutput = {
    topic_id: topicId,
    run_id: runId,
    enriched_party_ids: enrichedPartyIds,
    clue_ids: allClueIds,
    fact_check: factCheckTotals,
    total_clues_after: totalCluesAfter,
  }

  await writeArtifact(topicId, runId, "enrichment_output", output)
  return output
}

function getExistingCluesForParty(topicId: string, partyId: string) {
  const allClues = dbGetClues(topicId)
  return allClues
    .filter(clue => {
      const cur = clue.versions.find(v => v.v === clue.current)
      return cur?.party_relevance?.includes(partyId)
    })
    .map(clue => {
      const cur = clue.versions.find(v => v.v === clue.current)!
      return {
        id: clue.id,
        title: cur.title,
        summary: cur.bias_corrected_summary,
        credibility: cur.source_credibility.score,
        clue_type: cur.clue_type,
      }
    })
}



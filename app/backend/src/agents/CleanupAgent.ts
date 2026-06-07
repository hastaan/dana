import { resolvePrompt } from "../llm/promptLoader"
import { chatCompletionText } from "../llm/proxyClient"
import { budgetOutput } from "../llm/tokenBudget"
import { log } from "../utils/logger"

export interface ClueGroup {
  group_id: string
  category: string
  merged_title: string
  merged_summary: string
  merged_credibility: number
  merged_bias_flags: string[]
  merged_relevance: number
  merged_date: string
  merged_clue_type: string
  merged_domain_tags: string[]
  merged_parties: string[]
  source_clue_ids: string[]
  action: "merge" | "keep" | "delete"
  reason: string
  consolidation_type?: "dedup" | "consolidate"
}

type ClueInput = {
  id: string
  title: string
  summary: string
  date: string
  credibility: number
  relevance: number
  parties: string[]
  clue_type: string
  bias_flags: string[]
  domain_tags: string[]
}

type ScanCandidate = {
  ids: string[]
  type: "dedup" | "consolidate" | "garbage"
  reason: string
}

function parseJson<T>(raw: string): T | null {
  const match = raw.match(/\[[\s\S]*/)
  if (!match) return null
  let jsonStr = match[0]
  try { return JSON.parse(jsonStr) } catch { /* try salvage */ }
  const lastComma = jsonStr.lastIndexOf("},")
  const lastBrace = jsonStr.lastIndexOf("}")
  const cut = lastComma > 0 ? lastComma + 1 : lastBrace > 0 ? lastBrace + 1 : -1
  if (cut > 0) {
    try { return JSON.parse(jsonStr.slice(0, cut) + "]") } catch { /* failed */ }
  }
  return null
}

function clueToKeepGroup(clue: ClueInput): ClueGroup {
  return {
    group_id: clue.id,
    category: clue.clue_type,
    merged_title: clue.title,
    merged_summary: clue.summary,
    merged_credibility: clue.credibility,
    merged_bias_flags: clue.bias_flags,
    merged_relevance: clue.relevance,
    merged_date: clue.date,
    merged_clue_type: clue.clue_type,
    merged_domain_tags: clue.domain_tags,
    merged_parties: clue.parties,
    source_clue_ids: [clue.id],
    action: "keep",
    reason: "Unique clue — no duplicates found",
  }
}

export async function runCleanupPropose(
  topicId: string,
  topicTitle: string,
  clues: ClueInput[],
  parties: { id: string; name: string }[],
  model: string,
): Promise<ClueGroup[]> {
  const clueMap = new Map(clues.map(c => [c.id, c]))
  log.enrichment(`CleanupAgent: pass 1 — scanning ${clues.length} clues for duplicates`)

  // ── Pass 1: index scan (batched to stay within model context) ────────────────
  const scanConfig = await resolvePrompt("clue-extractor/cleanup-scan", { topic_title: topicTitle })
  const scanModel = scanConfig.model ?? model

  const indexLines = clues.map(c => {
    const excerpt = c.summary.slice(0, 100).replace(/\n/g, " ")
    const parties = c.parties.length > 0 ? c.parties.join(", ") : "none"
    return `[${c.id}] "${c.title}" (${c.date}, ${c.clue_type}) | parties: ${parties} | "${excerpt}..."`
  })

  // Batch into chunks of 40 clues to avoid context overflow
  const BATCH_SIZE = 40
  const batches: string[][] = []
  for (let i = 0; i < indexLines.length; i += BATCH_SIZE) {
    batches.push(indexLines.slice(i, i + BATCH_SIZE))
  }

  log.enrichment(`CleanupAgent: pass 1 — ${batches.length} batch(es) of up to ${BATCH_SIZE} clues`)

  const batchResults = await Promise.all(batches.map(async (batch, bi) => {
    const index = batch.join("\n")
    const scanRaw = await chatCompletionText({
      model: scanModel,
      messages: [
        { role: "system", content: scanConfig.content },
        { role: "user", content: `CLUE INDEX (batch ${bi + 1}/${batches.length}, ${batch.length} clues):\n${index}\n\nIdentify dedup candidates, consolidation threads, and garbage.` },
      ],
      temperature: 0.1,
      max_tokens: budgetOutput(scanModel, index, { min: 500, max: 2000 }),
    })
    log.enrichment(`CleanupAgent: batch ${bi + 1} raw (first 300): ${scanRaw.slice(0, 300)}`)
    return parseJson<ScanCandidate[]>(scanRaw) ?? []
  }))

  const candidates = batchResults.flat()
  log.enrichment(`CleanupAgent: pass 1 found ${candidates.length} candidate group(s)`)

  if (candidates.length === 0) {
    log.enrichment("CleanupAgent: no duplicates found — all clues kept")
    return clues.map(clueToKeepGroup)
  }

  // ── Pass 2: parallel resolution ────────────────────────────────────────────
  const resolveConfig = await resolvePrompt("clue-extractor/cleanup-resolve", {})
  const resolveModel = resolveConfig.model ?? model

  // Track which clue IDs are in candidate groups
  const candidateIds = new Set(candidates.flatMap(c => c.ids))

  // Single-id garbage candidates: auto-delete, no LLM call needed
  const autoDeleted = new Set<string>()
  const resolveGroups: ClueGroup[] = []

  for (const candidate of candidates) {
    if (candidate.ids.length === 1 && candidate.type === "garbage") {
      const clue = clueMap.get(candidate.ids[0])
      if (clue) {
        autoDeleted.add(clue.id)
        resolveGroups.push({
          ...clueToKeepGroup(clue),
          action: "delete",
          reason: candidate.reason,
        })
        log.enrichment(`CleanupAgent: auto-delete ${clue.id} (garbage)`)
      }
    }
  }

  // Multi-id candidates (and single non-garbage): send to LLM in parallel
  const toResolve = candidates.filter(c => !(c.ids.length === 1 && c.type === "garbage"))

  if (toResolve.length > 0) {
    log.enrichment(`CleanupAgent: pass 2 — resolving ${toResolve.length} candidate group(s) in parallel`)

    const resolved = await Promise.all(toResolve.map(async (candidate) => {
      const groupClues = candidate.ids
        .map(id => clueMap.get(id))
        .filter(Boolean) as ClueInput[]

      if (groupClues.length === 0) return []

      const clueDetail = groupClues.map(c =>
        `[${c.id}]\nTitle: ${c.title}\nDate: ${c.date}\nType: ${c.clue_type}\nParties: ${c.parties.join(", ")}\nCredibility: ${c.credibility}\nRelevance: ${c.relevance}\nSummary: ${c.summary}`
      ).join("\n\n---\n\n")

      const resolveRaw = await chatCompletionText({
        model: resolveModel,
        messages: [
          { role: "system", content: resolveConfig.content },
          {
            role: "user",
            content: `TOPIC: ${topicTitle}\nSUSPICION: ${candidate.type} — ${candidate.reason}\n\nCLUES TO EVALUATE:\n${clueDetail}`,
          },
        ],
        temperature: 0.1,
        max_tokens: budgetOutput(resolveModel, clueDetail, { min: 500, max: 2000 }),
      })

      const result = parseJson<ClueGroup[]>(resolveRaw)
      if (!result) {
        log.enrichment(`CleanupAgent: resolve parse failed for [${candidate.ids.join(",")}] — keeping all`)
        return groupClues.map(clueToKeepGroup)
      }

      // Ensure all input IDs are covered by the result
      const coveredIds = new Set(result.flatMap(g => g.source_clue_ids))
      const uncovered = groupClues.filter(c => !coveredIds.has(c.id))
      const extra = uncovered.map(clueToKeepGroup)

      // Attach consolidation_type to merged groups so the UI can show badges
      const ct = candidate.type === "garbage" ? undefined : candidate.type
      const tagged = result.map(g => g.action === "merge" ? { ...g, consolidation_type: ct } : g)

      log.enrichment(`CleanupAgent: resolved [${candidate.ids.join(",")}] type=${candidate.type} → ${result.map(g => g.action).join(",")}`)
      return [...tagged, ...extra]
    }))

    resolveGroups.push(...resolved.flat())
  }

  // ── Assemble final output ──────────────────────────────────────────────────
  // All clues not touched by any candidate group → auto-keep
  const handledIds = new Set([
    ...autoDeleted,
    ...resolveGroups.flatMap(g => g.source_clue_ids),
  ])
  const autoKept = clues
    .filter(c => !handledIds.has(c.id) && !candidateIds.has(c.id))
    .map(clueToKeepGroup)

  // Also auto-keep any candidateIds not handled (parse failures covered above, but safety net)
  const stillUnhandled = clues
    .filter(c => candidateIds.has(c.id) && !handledIds.has(c.id))
    .map(clueToKeepGroup)

  const allGroups = [...resolveGroups, ...autoKept, ...stillUnhandled]

  const mergeCount = allGroups.filter(g => g.action === "merge").length
  const deleteCount = allGroups.filter(g => g.action === "delete").length
  const keepCount = allGroups.filter(g => g.action === "keep").length
  log.enrichment(`CleanupAgent: done — ${mergeCount} merge, ${keepCount} keep, ${deleteCount} delete (${allGroups.length} total groups)`)

  return allGroups
}

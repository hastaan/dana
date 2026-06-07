import { chatCompletionText } from "../llm/proxyClient"
import { budgetOutput } from "../llm/tokenBudget"
import { resolvePrompt } from "../llm/promptLoader"
import { runAgenticLoop } from "../llm/agenticLoop"
import { emitThink } from "../routes/stream"
import { log } from "../utils/logger"
import { dbSetParties } from "../db/queries/parties"
import { writeArtifact } from "../tools/internal/artifactStore"
import { runDiscoveryResearcher } from "./DiscoveryResearcher"
import { scoreAllParties } from "./PartyScorer"
import { steeringBlock } from "../llm/steering"

export interface Party {
  id: string
  name: string
  type: "state" | "state_military" | "non_state" | "individual" | "media" | "economic" | "alliance"
  description: string
  weight: number
  weight_factors: {
    military_capacity: number
    economic_control: number
    information_control: number
    international_support: number
    internal_legitimacy: number
  }
  agenda: string
  means: string[]
  circle: { visible: string[]; shadow: string[] }
  stance: string
  vulnerabilities: string[]
  weight_evidence?: Record<string, string>
  auto_discovered: boolean
  user_verified: boolean
}

export interface DiscoveryOutput {
  topic_id: string
  parties: Party[]
  research_findings: { url: string; title: string; used_for: string }[]
  search_queries: string[]
  run_id: string
}

async function parseWithRetry<T>(
  call: (hint?: string) => Promise<string>,
  parse: (raw: string) => T,
  validate: (v: T) => boolean,
  maxAttempts = 3
): Promise<T> {
  let lastError = ""
  for (let i = 0; i < maxAttempts; i++) {
    const hint = i > 0 ? `Previous attempt failed: ${lastError}. Output ONLY valid JSON. No trailing commas. No markdown fences.` : undefined
    const raw = await call(hint)
    try {
      const v = parse(raw)
      if (!validate(v)) throw new Error("Validation failed")
      return v
    } catch (e) {
      lastError = String(e)
      log.discovery(`parseWithRetry attempt ${i + 1} failed: ${lastError}`)
    }
  }
  throw new Error(`Failed after ${maxAttempts} attempts: ${lastError}`)
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30)
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10)
}

function currentYear(): string {
  return new Date().getFullYear().toString()
}

export async function runDiscoveryAgent(
  topicId: string,
  title: string,
  description: string,
  model: string,
  runId: string,
  onProgress?: (msg: string) => void
): Promise<DiscoveryOutput> {
  const today = todayStr()
  const year = currentYear()

  // ─────────────────────────────────────────────
  // STEP 1: Orient — understand topic, plan research angles
  // ─────────────────────────────────────────────
  log.discovery(`Starting discovery for "${title}" on ${today}`)
  emitThink(topicId, "📅", `Today is ${today}`, "Orienting research…")
  onProgress?.(`Discovery: orienting for "${title}"`)

  const orientConfig = await resolvePrompt("discovery/orient", { today, year })
  const effectiveOrientModel = orientConfig.model ?? model
  const orientInput = `TOPIC: ${title}\n\nDESCRIPTION: ${description}`

  emitThink(topicId, "🧠", "Analyzing topic angles", "Economic · Geopolitical · Military · Adversarial…")

  const orientBudget = budgetOutput(effectiveOrientModel, orientConfig.content + orientInput, { min: 800, max: 2000 })
  const orientation = await parseWithRetry<{ angles: string[]; likely_party_types: string[]; seed_queries: string[] }>(
    async (hint) => {
      if (orientConfig.tools.length > 0) {
        return runAgenticLoop({
          model: effectiveOrientModel,
          topicId,
          stage: "discovery",
          tools: orientConfig.tools,
          messages: [
            { role: "system", content: orientConfig.content + steeringBlock(topicId, "research") },
            { role: "user", content: orientInput + (hint ? `\n\n${hint}` : "") },
          ],
          temperature: 0.3,
          max_tokens: orientBudget,
        })
      } else {
        return chatCompletionText({
          model: effectiveOrientModel,
          messages: [
            { role: "system", content: orientConfig.content + steeringBlock(topicId, "research") },
            { role: "user", content: orientInput + (hint ? `\n\n${hint}` : "") },
          ],
          temperature: 0.3,
          max_tokens: orientBudget,
        })
      }
    },
    (raw) => {
      const match = raw.match(/\{[\s\S]+\}/)
      if (!match) throw new Error("No JSON object found")
      return JSON.parse(match[0])
    },
    (v) => Array.isArray(v.seed_queries) && v.seed_queries.length >= 3
  )

  log.discovery(`Orientation: ${orientation.angles.length} angles, ${orientation.seed_queries.length} queries`)
  emitThink(topicId, "🗺️", `${orientation.angles.length} angles identified`, orientation.angles.slice(0, 3).join(" · "))

  // ─────────────────────────────────────────────
  // STEP 2: Agentic Research — model drives search, fetch, party identification
  // ─────────────────────────────────────────────
  onProgress?.("Discovery: agentic research in progress…")

  const researchResult = await runDiscoveryResearcher(
    topicId, title, description, model, orientation,
  )

  let parties = researchResult.parties

  // ─────────────────────────────────────────────
  // STEP 3: Refine parties — merge duplicates, delete unsupported, add missed
  // ─────────────────────────────────────────────
  onProgress?.("Discovery: refining party list…")
  emitThink(topicId, "🔀", "Refining party list", "Checking for merges, deletions, and new actors…")

  try {
    const partyListSummary = parties.map(p =>
      `${p.id} | ${p.name} (${p.type}) — ${p.agenda.slice(0, 120)}`
    ).join("\n")

    const sourceSummary = researchResult.sources
      .slice(0, 40)
      .map(s => `[${s.url}] ${s.title}: ${s.used_for}`)
      .join("\n")

    const refineConfig = await resolvePrompt("discovery/refine-parties", {
      today,
      topic: title,
      party_list: partyListSummary,
      research_summary: sourceSummary,
    })
    const effectiveRefineModel = refineConfig.model ?? model

    const refineBudget = budgetOutput(effectiveRefineModel, refineConfig.content, { min: 500, max: 1500 })
    const refineUserMsg = "Analyze the party list against the research findings and output your consolidation decisions."
    let refineRaw: string
    if (refineConfig.tools.length > 0) {
      refineRaw = await runAgenticLoop({
        model: effectiveRefineModel,
        topicId,
        stage: "discovery",
        tools: refineConfig.tools,
        messages: [
          { role: "system", content: refineConfig.content },
          { role: "user", content: refineUserMsg },
        ],
        temperature: 0.2,
        max_tokens: refineBudget,
      })
    } else {
      refineRaw = await chatCompletionText({
        model: effectiveRefineModel,
        messages: [
          { role: "system", content: refineConfig.content },
          { role: "user", content: refineUserMsg },
        ],
        temperature: 0.2,
        max_tokens: refineBudget,
      })
    }

    const refineMatch = refineRaw.match(/\{[\s\S]+\}/)
    if (refineMatch) {
      const decisions = JSON.parse(refineMatch[0]) as {
        merge: { source_ids: string[]; into: string; reason: string }[]
        delete: { id: string; reason: string }[]
        add: { name: string; type: Party["type"]; reason: string }[]
        group: { source_ids: string[]; alliance_name: string; reason: string; keep_separate?: string[] }[]
      }

      for (const del of (decisions.delete ?? [])) {
        const idx = parties.findIndex(p => p.id === del.id)
        if (idx !== -1) {
          emitThink(topicId, "🗑️", `Removing · ${parties[idx].name}`, del.reason)
          log.discovery(`Removing party "${parties[idx].name}": ${del.reason}`)
          parties.splice(idx, 1)
        }
      }

      for (const merge of (decisions.merge ?? [])) {
        const sources = merge.source_ids.map(id => parties.find(p => p.id === id)).filter(Boolean) as Party[]
        if (sources.length < 2) continue

        const merged: Party = {
          id: slugify(merge.into),
          name: merge.into,
          type: sources[0].type,
          description: sources.map(s => s.description).join(" "),
          weight: Math.round(sources.reduce((s, p) => s + p.weight, 0) / sources.length),
          weight_factors: sources[0].weight_factors,
          agenda: sources.map(s => s.agenda).filter(Boolean).join("; "),
          means: [...new Set(sources.flatMap(s => s.means))],
          circle: {
            visible: [...new Set(sources.flatMap(s => s.circle?.visible ?? []))],
            shadow: [...new Set(sources.flatMap(s => s.circle?.shadow ?? []))],
          },
          stance: sources[0].stance,
          vulnerabilities: [...new Set(sources.flatMap(s => s.vulnerabilities))],
          auto_discovered: true,
          user_verified: false,
        }

        for (const src of sources) {
          const idx = parties.findIndex(p => p.id === src.id)
          if (idx !== -1) parties.splice(idx, 1)
        }
        parties.push(merged)

        emitThink(topicId, "🔀", `Merging · ${sources.map(s => s.name).join(" + ")} → ${merge.into}`, merge.reason)
        log.discovery(`Merged → "${merge.into}": ${merge.reason}`)
      }

      for (const add of (decisions.add ?? [])) {
        if (parties.find(p => p.name.toLowerCase() === add.name.toLowerCase())) continue
        const stub: Party = {
          id: slugify(add.name),
          name: add.name,
          type: add.type ?? "non_state",
          description: add.reason,
          weight: 30,
          weight_factors: { military_capacity: 0, economic_control: 0, information_control: 0, international_support: 0, internal_legitimacy: 0 },
          agenda: add.reason,
          means: [],
          circle: { visible: [], shadow: [] },
          stance: "active",
          vulnerabilities: [],
          auto_discovered: true,
          user_verified: false,
        }
        parties.push(stub)
        emitThink(topicId, "➕", `Adding · ${add.name}`, add.reason)
        log.discovery(`Added party "${add.name}": ${add.reason}`)
      }

      // GROUP: consolidate aligned parties into alliances
      for (const group of (decisions.group ?? [])) {
        const keepSeparate = new Set(group.keep_separate ?? [])
        const sources = group.source_ids
          .filter(id => !keepSeparate.has(id))
          .map(id => parties.find(p => p.id === id))
          .filter(Boolean) as Party[]
        if (sources.length < 2) continue

        const alliance: Party = {
          id: slugify(group.alliance_name),
          name: group.alliance_name,
          type: "alliance",
          description: `Alliance of ${sources.map(s => s.name).join(", ")}. ${group.reason}`,
          weight: 0,
          weight_factors: { military_capacity: 0, economic_control: 0, information_control: 0, international_support: 0, internal_legitimacy: 0 },
          agenda: [...new Set(sources.map(s => s.agenda).filter(Boolean))].join("; "),
          means: [...new Set(sources.flatMap(s => s.means))],
          circle: {
            visible: sources.map(s => s.name),
            shadow: [...new Set(sources.flatMap(s => s.circle?.shadow ?? []))],
          },
          stance: sources[0].stance,
          vulnerabilities: [...new Set(sources.flatMap(s => s.vulnerabilities))],
          auto_discovered: true,
          user_verified: false,
        }

        for (const src of sources) {
          const idx = parties.findIndex(p => p.id === src.id)
          if (idx !== -1) parties.splice(idx, 1)
        }
        parties.push(alliance)

        emitThink(topicId, "🤝", `Alliance · ${sources.map(s => s.name).join(" + ")} → ${group.alliance_name}`, group.reason)
        log.discovery(`Grouped → "${group.alliance_name}": ${group.reason}`)
      }

      log.discovery(`Refinement complete: ${parties.length} parties`)
    }
  } catch (e) {
    log.discovery(`Party refinement failed (non-fatal): ${e}`)
  }

  // ─────────────────────────────────────────────
  // STEP 4: Evidence-based power scoring
  // ─────────────────────────────────────────────
  onProgress?.("Discovery: scoring party power axes…")
  emitThink(topicId, "📊", "Scoring party power", `${parties.length} parties × 5 axes with evidence`)

  try {
    parties = await scoreAllParties(topicId, title, description, parties, model)
  } catch (e) {
    log.error("DISCOVERY", "Party scoring failed (non-fatal), keeping preliminary scores", e)
  }

  // ─────────────────────────────────────────────
  // STEP 5: Save parties to DB
  // ─────────────────────────────────────────────
  emitThink(topicId, "💾", `Saving ${parties.length} parties`, `${researchResult.sources.length} sources collected`)
  log.discovery(`Saving ${parties.length} parties to DB`)

  dbSetParties(topicId, parties)
  onProgress?.(`Discovery: complete — ${parties.length} parties identified`)

  const output: DiscoveryOutput = {
    topic_id: topicId,
    parties,
    research_findings: researchResult.sources,
    search_queries: orientation.seed_queries,
    run_id: runId,
  }

  await writeArtifact(topicId, runId, "discovery_output", output)
  return output
}

import { resolvePrompt } from "../llm/promptLoader"
import { runAgenticLoop, type CustomToolHandler } from "../llm/agenticLoop"
import { dbGetControls } from "../db/queries/settings"
import { TOOL_REGISTRY } from "../llm/toolDefinitions"
import { budgetOutput } from "../llm/tokenBudget"
import { storeClue } from "../tools/processing/storeClue"
import { getPagesForParty } from "../db/queries/researchCorpus"
import { emitThink } from "../routes/stream"
import { log } from "../utils/logger"
import { steeringBlock } from "../llm/steering"
import type { Party } from "./DiscoveryAgent"

interface ExistingClue {
  id: string
  title: string
  summary: string
  credibility: number
  clue_type: string
}

export interface PartyEnrichmentResult {
  partyId: string
  storedClueIds: string[]
  profileUpdate: Partial<Party> | null
}

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, "") } catch { return url }
}

export async function runPartyEnrichmentAgent(
  topicId: string,
  title: string,
  description: string,
  party: Party,
  existingClues: ExistingClue[],
  model: string,
): Promise<PartyEnrichmentResult> {
  const today = new Date().toISOString().slice(0, 10)
  const year = new Date().getFullYear().toString()
  const currentMonth = new Date().toLocaleString("en-US", { month: "long", year: "numeric" })

  log.enrichment(`PartyEnrichmentAgent: starting for "${party.name}"`)
  emitThink(topicId, "🔬", `Enriching: ${party.name}`, `${existingClues.length} existing clues`)

  const partyProfile = JSON.stringify({
    id: party.id,
    name: party.name,
    type: party.type,
    description: party.description,
    weight: party.weight,
    agenda: party.agenda,
    means: party.means,
    circle: party.circle,
    stance: party.stance,
    vulnerabilities: party.vulnerabilities,
  }, null, 2)

  const existingCluesSummary = existingClues.length > 0
    ? existingClues.map(c => `- [${c.id}] (${c.clue_type}, cred=${c.credibility}) ${c.title}: ${c.summary.slice(0, 150)}`).join("\n")
    : "No existing clues for this party."

  const controls = dbGetControls()

  const config = await resolvePrompt("enrichment/agentic-enrich", {
    today,
    year,
    current_month: currentMonth,
    title,
    description,
    party_profile: partyProfile,
    existing_clues: existingCluesSummary,
    max_searches: String(controls.enrichment_max_searches_per_round),
    max_fetches: String(controls.enrichment_max_fetches_per_round),
  })
  const effectiveModel = config.model ?? model
  // Always include store_clue alongside config tools
  const storeClueToolDef = TOOL_REGISTRY["store_clue"]
  const effectiveTools = [...config.tools, ...(storeClueToolDef && !config.tools.some(t => t.function.name === "store_clue") ? [storeClueToolDef] : [])]

  const storedClueIds: string[] = []

  const storeClueHandler: CustomToolHandler = async (args) => {
    try {
      const sourceUrls = (args.source_urls as string[]) ?? []
      const sourceOutlets = (args.source_outlets as string[]) ?? sourceUrls.map(u => domainOf(u))

      const result = await storeClue({
        topicId,
        title: String(args.title ?? ""),
        sourceUrls,
        sourceOutlets,
        fetchedAt: new Date().toISOString(),
        processed: {
          extracted_content: "",
          bias_corrected_summary: String(args.summary ?? ""),
          bias_flags: (args.bias_flags as string[]) ?? [],
          source_credibility_score: Number(args.credibility ?? 50),
          credibility_notes: `Sources: ${sourceOutlets.join(", ")}`,
          origin_sources: sourceUrls.map((url, i) => ({
            url,
            outlet: sourceOutlets[i] ?? domainOf(url),
            is_republication: false,
          })),
          key_points: (args.key_points as string[]) ?? [],
          date_references: [String(args.date ?? today)],
          relevance_score: Number(args.relevance ?? 50),
        },
        partyRelevance: (args.parties as string[]) ?? [party.id],
        domainTags: (args.domain_tags as string[]) ?? [],
        timelineDate: String(args.date ?? today),
        clueType: String(args.clue_type ?? "fact"),
        addedBy: "auto",
        changeNote: `Enrichment agent: ${party.name}`,
        initialStatus: "pending",
      })

      if (result.status === "created") {
        storedClueIds.push(result.clue_id)
        emitThink(topicId, "📌", `Clue stored: ${String(args.title ?? "").slice(0, 50)}`, `${result.clue_id} · cred=${args.credibility}`)
        log.enrichment(`  Clue stored: ${result.clue_id} "${String(args.title ?? "").slice(0, 50)}"`)

        // Run adversarial fact-check on the distilled clue
        try {
          const { runFactCheck } = await import("./FactCheckAgent")
          const verdict = await runFactCheck({
            topicId,
            clueId: result.clue_id,
            title: String(args.title ?? ""),
            summary: String(args.summary ?? ""),
            sourceUrls,
            sourceOutlets,
            keyPoints: (args.key_points as string[]) ?? [],
            biasFlags: (args.bias_flags as string[]) ?? [],
            credibility: Number(args.credibility ?? 50),
            partyContext: party.name,
            topicTitle: title,
            topicDescription: description,
            model: effectiveModel,
          })
          log.enrichment(`  Fact-check: ${verdict.verdict} for "${String(args.title ?? "").slice(0, 40)}"`)
          emitThink(
            topicId,
            verdict.verdict === "verified" ? "✅" : verdict.verdict === "disputed" ? "🔶" : "⚠️",
            `${verdict.verdict.toUpperCase()}: ${String(args.title ?? "").slice(0, 50)}`,
            verdict.bias_analysis.slice(0, 100),
          )
          return JSON.stringify({ status: "created", clue_id: result.clue_id, fact_check: verdict.verdict, bias: verdict.bias_analysis.slice(0, 200) })
        } catch (fcErr) {
          log.enrichment(`  Fact-check failed for ${result.clue_id}: ${fcErr}`)
          return JSON.stringify({ status: "created", clue_id: result.clue_id, fact_check: "skipped" })
        }
      } else {
        log.enrichment(`  Duplicate clue skipped: ${result.clue_id}`)
        return JSON.stringify({ status: "duplicate", clue_id: result.clue_id, message: "This clue already exists" })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.enrichment(`  store_clue failed: ${msg}`)
      return JSON.stringify({ error: msg })
    }
  }

  // Inject corpus context from previous stages (discovery, scoring)
  let corpusContext = ""
  try {
    const corpusPages = getPagesForParty(topicId, party.name, 10)
    if (corpusPages.length > 0) {
      const previews = corpusPages.map(p => `- [${p.title}](${p.url}): ${p.content.slice(0, 200).replace(/\n/g, " ")}...`)
      corpusContext = `\n\nEXISTING RESEARCH CORPUS (${corpusPages.length} pages from earlier stages — use these to avoid redundant searches):\n${previews.join("\n")}`
      log.enrichment(`  Corpus: injected ${corpusPages.length} pages as context for ${party.name}`)
    }
  } catch { /* corpus unavailable, proceed without */ }

  const raw = await runAgenticLoop({
    model: effectiveModel,
    topicId,
    stage: "enrichment",
    tools: effectiveTools,
    maxIterations: controls.enrichment_iterations,
    temperature: 0.2,
    max_tokens: budgetOutput(effectiveModel, config.content, { min: 3000, max: 6000 }),
    contextWarningThreshold: controls.enrichment_context_warning,
    customTools: { store_clue: storeClueHandler },
    freeTools: ["store_clue"],
    perRoundCaps: {
      web_search: controls.enrichment_max_searches_per_round,
      fetch_url: controls.enrichment_max_fetches_per_round,
    },
    messages: [
      { role: "system", content: config.content + steeringBlock(topicId, "research") },
      { role: "user", content: `Begin your research on ${party.name}. Use the tools to search, fetch, and store clues. Each clue will be independently fact-checked. Output your final profile update as JSON when done.${corpusContext}` },
    ],
  })

  let profileUpdate: Partial<Party> | null = null

  try {
    const match = raw.match(/\{[\s\S]+\}/)
    if (match) {
      const parsed = JSON.parse(match[0])
      profileUpdate = parsed.profile_update ?? null
    }
  } catch (e) {
    log.enrichment(`PartyEnrichmentAgent: failed to parse final output for ${party.name}: ${e}`)
  }

  log.enrichment(`PartyEnrichmentAgent: ${party.name} complete — ${storedClueIds.length} clues stored`)
  emitThink(topicId, "✅", `Enrichment complete: ${party.name}`, `${storedClueIds.length} clues stored`)

  return {
    partyId: party.id,
    storedClueIds,
    profileUpdate,
  }
}

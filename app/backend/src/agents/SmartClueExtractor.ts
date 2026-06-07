import { chatCompletionText } from "../llm/proxyClient"
import { budgetOutput } from "../llm/tokenBudget"
import { resolvePrompt } from "../llm/promptLoader"
import { runAgenticLoop } from "../llm/agenticLoop"
import { gatherResearch } from "../tools/research/gatherResearch"
import { httpFetch } from "../tools/external/httpFetch"
import { storePage, getPage, storeSearch, findSimilarSearches } from "../db/queries/researchCorpus"
import { dbGetControls } from "../db/queries/settings"
import { webSearch } from "../tools/external/webSearch"
import { log } from "../utils/logger"
import { emitThink } from "../routes/stream"
import type { Party } from "./DiscoveryAgent"

export interface ExtractedClue {
  title: string
  summary: string
  date: string
  relevance: number
  credibility: number
  parties: string[]
  source_url: string
  source_outlet: string
  bias_flags: string[]
  clue_type: string
  domain_tags: string[]
  key_points: string[]
}

// Extract all URLs from mixed text
function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>")\]]+/g
  const matches = text.match(urlRegex) || []
  return [...new Set(matches)]
}

// Chunk text into segments that fit in LLM context
function chunkText(text: string, maxChars: number = 12000): string[] {
  if (text.length <= maxChars) return [text]
  const chunks: string[] = []
  const sections = text.split(/\n(?=[\*#\-]|\d{4}|[A-Z])/g)

  let current = ""
  for (const section of sections) {
    if (current.length + section.length > maxChars && current.length > 0) {
      chunks.push(current)
      current = section
    } else {
      current += (current ? "\n" : "") + section
    }
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

function isFetchable(url: string): boolean {
  const skip = ["x.com", "twitter.com", "instagram.com", "facebook.com", "truthsocial.com", "t.me"]
  try {
    const host = new URL(url).hostname
    return !skip.some(s => host.includes(s))
  } catch { return false }
}

export async function smartExtractClues(
  topicId: string,
  topicTitle: string,
  topicDescription: string,
  content: string,
  parties: Party[],
  model: string,
  onProgress?: (msg: string) => void,
): Promise<ExtractedClue[]> {
  const topicContext = `${topicTitle}: ${topicDescription}`
  const partyList = parties.map(p => `${p.id}: ${p.name}`).join("\n")

  // Step 1: Extract and fetch URLs from the text
  const urls = extractUrls(content)
  log.enrichment(`Smart extract: found ${urls.length} URLs in content`)
  onProgress?.(`Found ${urls.length} URLs, fetching accessible ones...`)

  const fetchableUrls = urls.filter(isFetchable)
  const fetchedContent: Record<string, string> = {}
  let fetched = 0

  const controls = dbGetControls()
  for (const url of fetchableUrls.slice(0, controls.smart_extract_url_limit)) {
    try {
      // Check corpus first
      const cached = (() => { try { return getPage(topicId, url) } catch { return null } })()
      if (cached && cached.contentLength > 100) {
        fetchedContent[url] = cached.content.slice(0, 3000)
        fetched++
        continue
      }
      const result = await httpFetch(url)
      if (result.raw_content.length > 100) {
        fetchedContent[url] = result.raw_content.slice(0, 3000)
        fetched++
        try { storePage(topicId, url, result.title, result.raw_content, "enrichment") } catch { /* non-fatal */ }
      }
    } catch { /* skip */ }
  }

  log.enrichment(`Smart extract: fetched ${fetched}/${fetchableUrls.length} URLs`)
  onProgress?.(`Fetched ${fetched} sources, extracting clues...`)

  // Step 2: Build enriched content with fetched material appended
  let enrichedContent = content
  if (Object.keys(fetchedContent).length > 0) {
    enrichedContent += "\n\n--- FETCHED SOURCE CONTENT ---\n"
    for (const [url, text] of Object.entries(fetchedContent)) {
      enrichedContent += `\n[SOURCE: ${url}]\n${text}\n`
    }
  }

  // Step 3: Chunk and extract clues from each chunk
  const chunks = chunkText(enrichedContent, 14000)
  log.enrichment(`Smart extract: processing ${chunks.length} chunk(s)`)

  const extractConfig = await resolvePrompt("clue-extractor/extract", { party_list: partyList })
  const effectiveModel = extractConfig.model ?? model

  const allClues: ExtractedClue[] = []

  for (let i = 0; i < chunks.length; i++) {
    onProgress?.(`Extracting clues from chunk ${i + 1}/${chunks.length}...`)

    const userContent = `TOPIC: ${topicContext}

INTELLIGENCE BRIEF (chunk ${i + 1}/${chunks.length}):
${chunks[i]}`

    let raw: string
    if (extractConfig.tools.length > 0) {
      raw = await runAgenticLoop({
        model: effectiveModel,
        topicId,
        stage: "enrichment",
        tools: extractConfig.tools,
        temperature: 0.2,
        max_tokens: budgetOutput(effectiveModel, topicContext + chunks[i], { min: 4000, max: 10000 }),
        messages: [
          { role: "system", content: extractConfig.content },
          { role: "user", content: userContent },
        ],
      })
    } else {
      raw = await chatCompletionText({
        model: effectiveModel,
        messages: [
          { role: "system", content: extractConfig.content },
          { role: "user", content: userContent },
        ],
        temperature: 0.2,
        max_tokens: budgetOutput(effectiveModel, topicContext + chunks[i], { min: 4000, max: 10000 }),
      })
    }

    try {
      const match = raw.match(/\[[\s\S]+/)
      if (!match) {
        log.error("SMART_EXTRACT", `No JSON array in chunk ${i + 1} response`)
        continue
      }
      let jsonStr = match[0]
      let extracted: ExtractedClue[]
      try {
        extracted = JSON.parse(jsonStr)
      } catch {
        // Truncated JSON — salvage complete objects by finding last complete }, then close the array
        const lastComplete = jsonStr.lastIndexOf("},")
        const lastObj = jsonStr.lastIndexOf("}")
        const cutPoint = lastComplete > 0 ? lastComplete + 1 : lastObj > 0 ? lastObj + 1 : -1
        if (cutPoint > 0) {
          const salvaged = jsonStr.slice(0, cutPoint) + "]"
          try {
            extracted = JSON.parse(salvaged)
            log.enrichment(`Chunk ${i + 1}: salvaged ${extracted.length} clues from truncated JSON`)
          } catch {
            log.error("SMART_EXTRACT", `Parse error chunk ${i + 1} (salvage failed)`)
            continue
          }
        } else {
          log.error("SMART_EXTRACT", `Parse error chunk ${i + 1} (no salvageable objects)`)
          continue
        }
      }
      allClues.push(...extracted)
      log.enrichment(`Chunk ${i + 1}: extracted ${extracted.length} clues`)
    } catch (e) {
      log.error("SMART_EXTRACT", `Parse error chunk ${i + 1}`, e)
    }
  }

  // Step 4: Deduplicate by title similarity
  const seen = new Set<string>()
  const deduped = allClues.filter(c => {
    const key = c.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 50)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  log.enrichment(`Smart extract complete: ${deduped.length} unique clues from ${allClues.length} total`)
  onProgress?.(`Extracted ${deduped.length} clues`)
  return deduped
}

// Smart edit a single clue based on user feedback
export async function smartEditClue(
  topicId: string,
  topicTitle: string,
  currentClue: {
    title: string
    summary: string
    credibility: number
    bias_flags: string[]
    relevance: number
    parties: string[]
    source_url: string
    source_outlet: string
    date: string
    clue_type: string
  },
  feedback: string,
  model: string,
): Promise<{
  title: string
  summary: string
  credibility: number
  bias_flags: string[]
  relevance: number
  parties: string[]
  date: string
  clue_type: string
  domain_tags: string[]
}> {
  log.enrichment(`Smart clue edit: "${currentClue.title}" — "${feedback.slice(0, 80)}"`)
  emitThink(topicId, "📝", "Smart edit started", `Editing "${currentClue.title}" — ${feedback.slice(0, 80)}`)

  const editConfig = await resolvePrompt("clue-extractor/edit")

  const raw = await runAgenticLoop({
    model: editConfig.model ?? model,
    topicId,
    stage: "enrichment",
    tools: editConfig.tools,
    temperature: 0.2,
    max_tokens: budgetOutput(editConfig.model ?? model, topicTitle + JSON.stringify(currentClue) + feedback, { min: 1000, max: 3000 }),
    messages: [
      {
        role: "system",
        content: editConfig.content,
      },
      {
        role: "user",
        content: `TOPIC: ${topicTitle}

CURRENT CLUE:
${JSON.stringify(currentClue, null, 2)}

USER FEEDBACK:
${feedback}

Research the feedback using the available tools, then output the updated clue as valid JSON (no markdown fences).`,
      },
    ],
  })

  const match = raw.match(/\{[\s\S]+\}/)
  if (!match) throw new Error("Failed to parse clue JSON from LLM response")
  const updated = JSON.parse(match[0])

  log.enrichment(`Smart clue edit complete: "${updated.title}"`)
  emitThink(topicId, "✅", "Smart edit complete", `Updated: "${updated.title}"`)
  return updated
}

// Research a direction/question and extract clues from findings
export async function researchAndExtractClues(
  topicId: string,
  topicTitle: string,
  topicDescription: string,
  query: string,
  parties: Party[],
  model: string,
): Promise<ExtractedClue[]> {
  const partyList = parties.map(p => `${p.id}: ${p.name}`).join("\n")

  log.enrichment(`Research: generating search queries for "${query.slice(0, 80)}"`)

  const queriesConfig = await resolvePrompt("clue-extractor/queries")
  const queriesModel = queriesConfig.model ?? model

  const queriesUserContent = `TOPIC: ${topicTitle}
RESEARCH DIRECTION: ${query}

Generate 3-5 specific, fact-finding search queries that would uncover concrete evidence, events, statements, or data related to this research direction. Focus on recent news and verifiable facts.`

  // Step 1: LLM generates targeted search queries from the user's research direction
  let queriesRaw: string
  if (queriesConfig.tools.length > 0) {
    queriesRaw = await runAgenticLoop({
      model: queriesModel,
      topicId,
      stage: "enrichment",
      tools: queriesConfig.tools,
      temperature: 0.3,
      max_tokens: 500,
      messages: [
        { role: "system", content: queriesConfig.content },
        { role: "user", content: queriesUserContent },
      ],
    })
  } else {
    queriesRaw = await chatCompletionText({
      model: queriesModel,
      messages: [
        { role: "system", content: queriesConfig.content },
        { role: "user", content: queriesUserContent },
      ],
      temperature: 0.3,
      max_tokens: 500,
    })
  }

  let searchQueries: string[] = []
  try {
    const match = queriesRaw.match(/\[[\s\S]+\]/)
    if (match) searchQueries = JSON.parse(match[0])
  } catch { /* fallback */ }
  if (searchQueries.length === 0) {
    searchQueries = [query, `${query} ${topicTitle} ${new Date().getFullYear()}`]
  }

  log.enrichment(`Research: ${searchQueries.length} search queries: ${searchQueries.join(" | ")}`)

  // Step 2: Search and fetch (corpus-aware)
  const controls = dbGetControls()
  const cacheMaxAgeMs = controls.corpus_cache_hours * 60 * 60 * 1000
  const fetchedContent: string[] = []
  for (const sq of searchQueries.slice(0, controls.research_search_queries)) {
    try {
      // Check corpus for cached search
      let results = (() => {
        try {
          const cached = findSimilarSearches(topicId, sq)
          if (cached.length > 0) {
            const age = Date.now() - new Date(cached[0].searchedAt).getTime()
            if (age < cacheMaxAgeMs && cached[0].resultCount > 0) {
              log.enrichment(`Research CORPUS HIT: "${sq}" → ${cached[0].resultCount} cached`)
              return cached[0].results
            }
          }
        } catch { /* fall through */ }
        return null
      })()

      if (!results) {
        results = await webSearch(sq, 3)
        try { storeSearch(topicId, sq, results, "enrichment") } catch { /* non-fatal */ }
      }

      for (const r of results.slice(0, 2)) {
        try {
          if (!isFetchable(r.url)) {
            if (r.snippet) fetchedContent.push(`[${r.title}] (${r.url})\n${r.snippet}`)
            continue
          }
          // Check corpus for cached page
          const cachedPage = (() => { try { return getPage(topicId, r.url) } catch { return null } })()
          if (cachedPage) {
            fetchedContent.push(`[${cachedPage.title}] (${r.url})\n${cachedPage.content.slice(0, 2000)}`)
            continue
          }
          const fetched = await httpFetch(r.url)
          fetchedContent.push(`[${r.title}] (${r.url})\n${fetched.raw_content.slice(0, 2000)}`)
          try { storePage(topicId, r.url, fetched.title, fetched.raw_content, "enrichment") } catch { /* non-fatal */ }
        } catch {
          if (r.snippet) fetchedContent.push(`[${r.title}] (${r.url})\n${r.snippet}`)
        }
      }
    } catch { /* skip */ }
  }

  log.enrichment(`Research: fetched ${fetchedContent.length} source fragments`)

  if (fetchedContent.length === 0) {
    log.enrichment("Research: no sources found, returning empty")
    return []
  }

  // Step 3: Extract clues from research findings
  const combinedResearch = fetchedContent.join("\n\n---\n\n").slice(0, 12000)

  const researchConfig = await resolvePrompt("clue-extractor/research", { party_list: partyList })
  const researchModel = researchConfig.model ?? model

  const researchUserContent = `TOPIC: ${topicTitle}: ${topicDescription}

RESEARCH QUESTION: ${query}

GATHERED SOURCES:
${combinedResearch}

Extract all relevant factual claims as structured clues.`

  let raw: string
  if (researchConfig.tools.length > 0) {
    raw = await runAgenticLoop({
      model: researchModel,
      topicId,
      stage: "enrichment",
      tools: researchConfig.tools,
      temperature: 0.2,
      max_tokens: budgetOutput(researchModel, partyList + combinedResearch + query, { min: 4000, max: 10000 }),
      messages: [
        { role: "system", content: researchConfig.content },
        { role: "user", content: researchUserContent },
      ],
    })
  } else {
    raw = await chatCompletionText({
      model: researchModel,
      messages: [
        { role: "system", content: researchConfig.content },
        { role: "user", content: researchUserContent },
      ],
      temperature: 0.2,
      max_tokens: budgetOutput(researchModel, partyList + combinedResearch + query, { min: 4000, max: 10000 }),
    })
  }

  try {
    const match = raw.match(/\[[\s\S]+\]/)
    if (!match) throw new Error("No JSON array")
    const clues = JSON.parse(match[0]) as ExtractedClue[]
    log.enrichment(`Research: extracted ${clues.length} clues for "${query.slice(0, 50)}"`)
    return clues
  } catch (e) {
    log.error("RESEARCH", "Failed to parse extracted clues", e)
    return []
  }
}

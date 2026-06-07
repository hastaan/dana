import { chatCompletion } from "./proxyClient"
import type { ChatMessage, ToolDefinition, ToolCall } from "./proxyClient"
import { webSearch } from "../tools/external/webSearch"
import { httpFetch } from "../tools/external/httpFetch"
import { storeSearch, storePage, findSimilarSearches, getPage } from "../db/queries/researchCorpus"
import { dbGetControls } from "../db/queries/settings"
import { emitThink } from "../routes/stream"
import { log } from "../utils/logger"

const CHARS_PER_TOKEN = 4

export type CustomToolHandler = (args: Record<string, unknown>) => Promise<string>

interface AgenticLoopOptions {
  model: string
  messages: ChatMessage[]
  tools: ToolDefinition[]
  topicId: string
  stage?: string
  maxIterations?: number
  temperature?: number
  max_tokens?: number
  customTools?: Record<string, CustomToolHandler>
  contextWarningThreshold?: number
  freeTools?: string[]
  perRoundCaps?: Record<string, number>
}

function stageLog(stage: string, msg: string, detail?: string) {
  const fn = (log as Record<string, unknown>)[stage]
  if (typeof fn === "function") (fn as (m: string, d?: string) => void)(msg, detail)
  else log.stage(stage, msg, detail)
}

function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0
  for (const m of messages) {
    if (m.content) chars += m.content.length
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        chars += tc.function.name.length + tc.function.arguments.length
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

async function executeBuiltinTool(call: ToolCall, topicId: string, stage: string): Promise<string> {
  const controls = dbGetControls()
  const maxFetchChars = controls.max_fetch_chars
  const cacheMaxAgeMs = controls.corpus_cache_hours * 60 * 60 * 1000

  const name = call.function.name
  let args: Record<string, unknown>
  try {
    args = JSON.parse(call.function.arguments)
  } catch {
    return JSON.stringify({ error: "Invalid JSON arguments" })
  }

  if (name === "web_search") {
    const query = String(args.query ?? "")
    const searchResultsCap = controls.enrichment_search_results ?? 5
    const numResults = Math.min(Math.max(Number(args.num_results) || 3, 1), searchResultsCap)
    const language = args.language ? String(args.language) : undefined
    const langTag = language ? ` [${language}]` : ""
    emitThink(topicId, "🔎", "Searching" + langTag, query)
    stageLog(stage, `Tool call: web_search("${query}", ${numResults}${language ? `, lang=${language}` : ""})`)

    // Check corpus for similar recent search
    try {
      const cached = findSimilarSearches(topicId, query)
      if (cached.length > 0) {
        const age = Date.now() - new Date(cached[0].searchedAt).getTime()
        if (age < cacheMaxAgeMs && cached[0].resultCount > 0) {
          emitThink(topicId, "📦", `Corpus hit: ${cached[0].resultCount} cached results`, `"${cached[0].query}"`)
          stageLog(stage, `web_search CORPUS HIT: "${query}" → ${cached[0].resultCount} cached results from "${cached[0].query}"`)
          return JSON.stringify(cached[0].results.slice(0, numResults).map(r => ({ title: r.title, url: r.url, snippet: r.snippet, date: r.date })))
        }
      }
    } catch { /* corpus query failed, proceed with live search */ }

    try {
      const results = await webSearch(query, numResults, undefined, language)
      emitThink(topicId, "📄", `Found ${results.length} results` + langTag, results.slice(0, 3).map(r => r.title).join(", "))
      stageLog(stage, `web_search: ${results.length} results for "${query}"${langTag}`)

      // Store in corpus
      try { storeSearch(topicId, query, results, stage) } catch { /* non-fatal */ }

      return JSON.stringify(results.map(r => ({ title: r.title, url: r.url, snippet: r.snippet, date: r.date })))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitThink(topicId, "⚠", "Search failed", msg)
      stageLog(stage, `web_search failed: ${msg}`)
      return JSON.stringify({ error: msg })
    }
  }

  if (name === "fetch_url") {
    const url = String(args.url ?? "")
    emitThink(topicId, "🌐", "Fetching", url)
    stageLog(stage, `Tool call: fetch_url("${url}")`)

    // Check corpus for existing page
    try {
      const cached = getPage(topicId, url)
      if (cached) {
        const content = cached.content.slice(0, maxFetchChars)
        emitThink(topicId, "📦", "Corpus hit", `${cached.title} (${cached.contentLength} chars)`)
        stageLog(stage, `fetch_url CORPUS HIT: "${cached.title}" (${cached.contentLength} chars)`)
        return JSON.stringify({ title: cached.title, content })
      }
    } catch { /* corpus query failed, proceed with live fetch */ }

    try {
      const result = await httpFetch(url)
      const content = result.raw_content.slice(0, maxFetchChars)
      emitThink(topicId, "✓", "Fetched", `${result.title} (${result.raw_content.length} chars)`)
      stageLog(stage, `fetch_url: ${result.title} (${result.raw_content.length} chars)`)

      // Store in corpus
      try { storePage(topicId, url, result.title, result.raw_content, stage) } catch { /* non-fatal */ }

      return JSON.stringify({ title: result.title, content })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emitThink(topicId, "⚠", "Fetch failed", msg)
      stageLog(stage, `fetch_url failed: ${msg}`)
      return JSON.stringify({ error: msg })
    }
  }

  return JSON.stringify({ error: `Unknown built-in tool: ${name}` })
}

export async function runAgenticLoop(options: AgenticLoopOptions): Promise<string> {
  const { model, tools, topicId, temperature, max_tokens, customTools } = options
  const stage = options.stage ?? "tool"
  const maxIter = options.maxIterations ?? dbGetControls().default_max_iterations
  const contextWarning = options.contextWarningThreshold ?? dbGetControls().default_context_warning
  const freeTools = new Set(options.freeTools ?? [])
  const perRoundCaps = options.perRoundCaps ?? {}
  const hasBudgetMode = freeTools.size > 0
  const messages: ChatMessage[] = [...options.messages]
  let contextWarned = false
  let researchCount = 0
  let researchExhausted = false
  const hardCap = maxIter + 10

  for (let totalRounds = 0; totalRounds < hardCap; totalRounds++) {
    const response = await chatCompletion({
      model,
      messages,
      tools,
      tool_choice: "auto",
      temperature,
      max_tokens,
    })

    const choice = response.choices[0]
    if (!choice) throw new Error("No response from LLM")

    const assistantMsg = choice.message
    messages.push(assistantMsg)

    if (!assistantMsg.tool_calls?.length) {
      return assistantMsg.content ?? ""
    }

    // Enforce per-round caps: count calls per tool, skip excess
    const toolCallCounts: Record<string, number> = {}
    const executableCalls: ToolCall[] = []
    const skippedCalls: ToolCall[] = []

    for (const tc of assistantMsg.tool_calls) {
      const name = tc.function.name
      toolCallCounts[name] = (toolCallCounts[name] ?? 0) + 1
      if (perRoundCaps[name] && toolCallCounts[name] > perRoundCaps[name]) {
        skippedCalls.push(tc)
      } else {
        executableCalls.push(tc)
      }
    }

    // Determine if this round has research tools (non-free)
    const hasResearchTool = executableCalls.some(tc => !freeTools.has(tc.function.name))
    const roundLabel = hasBudgetMode
      ? `Round ${totalRounds + 1} (research ${researchCount + (hasResearchTool ? 1 : 0)}/${maxIter})`
      : `Iteration ${totalRounds + 1}`

    emitThink(topicId, "🔧", roundLabel, executableCalls.map(tc => tc.function.name).join(", "))
    stageLog(stage, `Agentic loop ${roundLabel}: ${executableCalls.length} tool call(s)${skippedCalls.length ? ` (${skippedCalls.length} capped)` : ""}`)

    // Execute tool calls
    for (const toolCall of executableCalls) {
      let result: string
      if (customTools && customTools[toolCall.function.name]) {
        let args: Record<string, unknown>
        try { args = JSON.parse(toolCall.function.arguments) } catch { args = {} }
        result = await customTools[toolCall.function.name](args)
      } else {
        result = await executeBuiltinTool(toolCall, topicId, stage)
      }
      messages.push({ role: "tool", content: result, tool_call_id: toolCall.id })
    }

    // Return cap-exceeded messages for skipped calls
    for (const tc of skippedCalls) {
      const cap = perRoundCaps[tc.function.name]
      stageLog(stage, `  ${tc.function.name} capped (${cap}/round)`)
      messages.push({ role: "tool", content: JSON.stringify({ error: `Per-round cap reached (${cap} ${tc.function.name} calls/round). Try in the next round.` }), tool_call_id: tc.id })
    }

    // Budget counting (only in budget mode)
    if (hasBudgetMode && hasResearchTool) {
      researchCount++

      if (!researchExhausted && researchCount === maxIter - 1) {
        emitThink(topicId, "⏱", "1 research round remaining", "Plan your final searches carefully.")
        stageLog(stage, `Budget warning: 1 research round remaining (${researchCount}/${maxIter})`)
        messages.push({
          role: "user",
          content: `BUDGET WARNING: You have 1 research round remaining (${researchCount}/${maxIter}). Plan your final searches carefully. After that, analyze all gathered evidence and store your distilled clues using store_clue.`,
        })
      }

      if (!researchExhausted && researchCount >= maxIter) {
        researchExhausted = true
        emitThink(topicId, "📊", "Research complete — storing clues", `${researchCount} rounds used`)
        stageLog(stage, `Research budget exhausted (${researchCount}/${maxIter}). Entering storage phase.`)
        messages.push({
          role: "user",
          content: "RESEARCH PHASE COMPLETE. You have used all your research rounds. Now analyze everything you gathered and call store_clue for ALL your distilled findings in a SINGLE batch — call store_clue multiple times in one response, one call per distinct clue. Each clue should synthesize related sources into a single multi-source finding. store_clue calls are completely free. When done storing all clues, output your final profile_update JSON.",
        })
      }
    }

    // Legacy mode (no freeTools): simple iteration counting
    if (!hasBudgetMode && totalRounds + 1 >= maxIter) {
      stageLog(stage, `Agentic loop hit max iterations (${maxIter}), forcing final response`)
      emitThink(topicId, "⏱", "Max rounds reached", "Generating final answer...")
      messages.push({ role: "user", content: "You have done enough research. Now output your final answer as valid JSON based on everything you have gathered. No more tool calls." })
      const finalResponse = await chatCompletion({ model, messages, temperature, max_tokens })
      return finalResponse.choices[0]?.message?.content ?? ""
    }

    // Context warning (both modes)
    if (!contextWarned) {
      const estTokens = estimateTokens(messages)
      if (estTokens > contextWarning) {
        contextWarned = true
        emitThink(topicId, "⏱", "Context budget high", `~${Math.round(estTokens / 1000)}k tokens used.`)
        stageLog(stage, `Agentic loop: context warning at ~${estTokens} tokens`)
        messages.push({
          role: "user",
          content: "IMPORTANT: You are approaching the context budget limit. Wrap up your work and produce your final output soon.",
        })
      }
    }
  }

  // Hard cap reached (budget mode only — shouldn't normally happen)
  stageLog(stage, `Agentic loop hard cap reached (${hardCap} total rounds), forcing final response`)
  messages.push({ role: "user", content: "You have done enough. Output your final answer as valid JSON now. No more tool calls." })
  const finalResponse = await chatCompletion({ model, messages, temperature, max_tokens })
  return finalResponse.choices[0]?.message?.content ?? ""
}

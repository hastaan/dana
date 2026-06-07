import { chatCompletionText } from "../../llm/proxyClient"
import { resolvePrompt } from "../../llm/promptLoader"

import type { OriginSource } from "../../db/queries/clues"
export type { OriginSource }

export interface ClueProcessorOutput {
  extracted_content: string
  bias_corrected_summary: string
  bias_flags: string[]
  source_credibility_score: number
  credibility_notes: string
  origin_sources: OriginSource[]
  origin_source?: OriginSource   // legacy compat
  key_points: string[]
  date_references: string[]
  relevance_score: number
}

// Slim output for Discovery — only what's needed, ~150-200 tokens max
interface SlimProcessorOutput {
  bias_corrected_summary: string
  relevance_score: number
}

const SLIM_SYSTEM_PROMPT = `You are a neutral intelligence analyst. Given raw web content and a topic context, extract a short bias-corrected summary and score relevance.

Output ONLY a valid JSON object with exactly these two fields:
{
  "bias_corrected_summary": "<2-3 sentence neutral summary of key facts relevant to the topic>",
  "relevance_score": <integer 0-100 indicating relevance to the topic context>
}

Rules:
- bias_corrected_summary must be strictly neutral — remove loaded language and emotional framing
- relevance_score: 0 = completely unrelated, 100 = directly on-topic
- Output ONLY the JSON object, no prose, no markdown fences`

export async function processClue(
  rawHtml: string,
  sourceUrl: string,
  topicContext: string,
  model: string = "claude-haiku-4-5-20251001",
  slim: boolean = false
): Promise<ClueProcessorOutput> {
  const systemConfig = await resolvePrompt("clue-processor/system")
  const effectiveModel = systemConfig.model ?? model
  const SYSTEM_PROMPT = systemConfig.content

  const truncatedHtml = rawHtml.slice(0, 6000)

  const prompt = `SOURCE URL: ${sourceUrl}

TOPIC CONTEXT: ${topicContext}

RAW CONTENT:
${truncatedHtml}

Extract, bias-correct, and analyze this content for the topic context above.`

  if (slim) {
    const text = await chatCompletionText({
      model,
      messages: [
        { role: "system", content: SLIM_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 250,
    })

    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/) || text.match(/(\{[\s\S]+\})/)
    const jsonStr = jsonMatch ? jsonMatch[1] : text

    try {
      const parsed = JSON.parse(jsonStr) as SlimProcessorOutput
      if (parsed.bias_corrected_summary === undefined || parsed.relevance_score === undefined) {
        throw new Error("Missing required slim fields")
      }
      // Return as ClueProcessorOutput with stub values for unused fields
      return {
        extracted_content: "",
        bias_corrected_summary: parsed.bias_corrected_summary,
        bias_flags: [],
        source_credibility_score: 50,
        credibility_notes: "",
        origin_sources: [{ url: sourceUrl, outlet: "", is_republication: false }],
        key_points: [],
        date_references: [],
        relevance_score: parsed.relevance_score,
      }
    } catch (e) {
      throw new Error(`ClueProcessor (slim): failed to parse JSON: ${e}\nResponse: ${text.slice(0, 200)}`)
    }
  }

  const text = await chatCompletionText({
    model: effectiveModel,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    temperature: 0.2,
    max_tokens: 1500,
  })

  // Extract JSON from response — handle markdown code fences if present
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/) || text.match(/(\{[\s\S]+\})/)
  const jsonStr = jsonMatch ? jsonMatch[1] : text

  try {
    const parsed = JSON.parse(jsonStr) as any
    const required = [
      "extracted_content", "bias_corrected_summary", "bias_flags",
      "source_credibility_score", "credibility_notes",
      "key_points", "date_references", "relevance_score"
    ]
    for (const field of required) {
      if (parsed[field] === undefined) throw new Error(`Missing field: ${field}`)
    }
    // Normalize origin_source → origin_sources
    if (!parsed.origin_sources && parsed.origin_source) {
      parsed.origin_sources = [parsed.origin_source]
    }
    if (!parsed.origin_sources) {
      parsed.origin_sources = [{ url: sourceUrl, outlet: "", is_republication: false }]
    }
    return parsed as ClueProcessorOutput
  } catch (e) {
    throw new Error(`ClueProcessor: failed to parse LLM response as JSON: ${e}\nResponse: ${text.slice(0, 200)}`)
  }
}

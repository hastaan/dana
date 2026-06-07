import type { ToolDefinition } from "./proxyClient"

const WEB_SEARCH: ToolDefinition = {
  type: "function",
  function: {
    name: "web_search",
    description: "Search the web for current information. Use specific, targeted queries. Returns a list of results with title, URL, snippet, and date.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query — be specific and include key terms, dates, or entity names" },
        num_results: { type: "number", description: "Number of results to return (1-5)", default: 3 },
        language: { type: "string", description: "Optional ISO 639-1 language code to bias results toward that language (e.g. 'sv' for Swedish, 'zh' for Chinese, 'de' for German). Use when native-language sources would yield better results." },
      },
      required: ["query"],
    },
  },
}

const FETCH_URL: ToolDefinition = {
  type: "function",
  function: {
    name: "fetch_url",
    description: "Fetch and read the full text content of a web page. Use this to get details from a search result URL. Returns the page title and text content.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch" },
      },
      required: ["url"],
    },
  },
}

const STORE_CLUE: ToolDefinition = {
  type: "function",
  function: {
    name: "store_clue",
    description: "Store a verified clue/evidence item in the database. Use this to save each piece of evidence you find. You will receive confirmation with the clue ID.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Concise factual title stating the key finding" },
        summary: { type: "string", description: "2-3 sentence neutral, bias-corrected summary citing source domains inline" },
        credibility: { type: "number", description: "Credibility score 0-100 (80+ = official data sources, 60-79 = credible journalism, <60 = unverified)" },
        relevance: { type: "number", description: "Relevance to the topic 0-100" },
        source_urls: { type: "array", items: { type: "string" }, description: "All URLs used as sources for this clue" },
        source_outlets: { type: "array", items: { type: "string" }, description: "Source outlet names (e.g. Reuters, EIA)" },
        parties: { type: "array", items: { type: "string" }, description: "Party IDs this clue is relevant to" },
        date: { type: "string", description: "Most relevant date for this evidence (YYYY-MM-DD)" },
        clue_type: { type: "string", description: "One of: event, statement, military_action, intelligence, economic, diplomatic, fact, news" },
        domain_tags: { type: "array", items: { type: "string" }, description: "Domain tags: economic, military, political, diplomatic, intelligence" },
        bias_flags: { type: "array", items: { type: "string" }, description: "Bias flags if applicable, else empty array" },
        key_points: { type: "array", items: { type: "string" }, description: "2-4 specific verifiable facts from this clue" },
        updates_clue_id: { type: "string", description: "If this clue updates an existing one, provide the existing clue ID here. A new version will be added instead of creating a duplicate." },
      },
      required: ["title", "summary", "credibility", "relevance", "source_urls", "parties", "date", "clue_type"],
    },
  },
}

export const TOOL_REGISTRY: Record<string, ToolDefinition> = {
  web_search: WEB_SEARCH,
  fetch_url: FETCH_URL,
  store_clue: STORE_CLUE,
}

export const RESEARCH_TOOLS: ToolDefinition[] = [WEB_SEARCH, FETCH_URL]
export const DISCOVERY_TOOLS: ToolDefinition[] = [WEB_SEARCH, FETCH_URL]
export const ENRICHMENT_TOOLS: ToolDefinition[] = [WEB_SEARCH, FETCH_URL, STORE_CLUE]

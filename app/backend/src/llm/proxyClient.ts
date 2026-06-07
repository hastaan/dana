import { log } from "../utils/logger"

const PROXY_BASE_URL = process.env.PROXY_BASE_URL || "http://127.0.0.1:8317"
const TIMEOUT_MS = 300_000  // 5 minutes — Opus can take a while on complex prompts
const RETRY_BACKOFFS = [1000, 5000, 15000]

export interface ModelInfo {
  id: string
  object: string
  created?: number
  owned_by?: string
}

export interface ToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export interface ToolDefinition {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ChatCompletionOptions {
  model: string
  messages: ChatMessage[]
  temperature?: number
  max_tokens?: number
  stream?: boolean
  tools?: ToolDefinition[]
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } }
}

export interface ChatCompletionResponse {
  id: string
  choices: { message: ChatMessage; finish_reason: string }[]
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}

// Token bucket rate limiter per model tier
class TokenBucket {
  private tokens: number
  private lastRefill: number
  private readonly rps: number
  private readonly burst: number

  constructor({ rps, burst }: { rps: number; burst: number }) {
    this.rps = rps
    this.burst = burst
    this.tokens = burst
    this.lastRefill = Date.now()
  }

  async acquire(): Promise<void> {
    while (true) {
      const now = Date.now()
      const elapsed = (now - this.lastRefill) / 1000
      this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rps)
      this.lastRefill = now

      if (this.tokens >= 1) {
        this.tokens -= 1
        return
      }

      const waitMs = ((1 - this.tokens) / this.rps) * 1000
      await new Promise(r => setTimeout(r, waitMs))
    }
  }
}

const rateLimiters: Record<string, TokenBucket> = {}

function getRateLimiter(model: string): TokenBucket {
  if (!rateLimiters[model]) {
    if (model.includes("opus")) {
      rateLimiters[model] = new TokenBucket({ rps: 2, burst: 5 })
    } else if (model.includes("sonnet")) {
      rateLimiters[model] = new TokenBucket({ rps: 5, burst: 10 })
    } else {
      rateLimiters[model] = new TokenBucket({ rps: 20, burst: 40 })
    }
  }
  return rateLimiters[model]
}

async function fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

let _modelsCache: { models: ModelInfo[]; fetchedAt: number } | null = null
const MODELS_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

let _verifiedModels: { ids: Set<string>; verifiedAt: number } | null = null
const VERIFIED_CACHE_TTL = 30 * 60 * 1000 // 30 minutes
let _verificationPromise: Promise<Set<string>> | null = null

async function verifyModel(modelId: string): Promise<boolean> {
  try {
    const res = await fetch(`${PROXY_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.PROXY_API_KEY || "sk-dummy"}`,
      },
      body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      if (text.includes("auth_unavailable") || text.includes("no auth available")) return false
    }
    return res.ok
  } catch {
    return false
  }
}

async function runVerification(models: ModelInfo[]): Promise<Set<string>> {
  const verified = new Set<string>()
  const BATCH = 3
  for (let i = 0; i < models.length; i += BATCH) {
    const batch = models.slice(i, i + BATCH)
    const results = await Promise.all(batch.map(async m => ({ id: m.id, ok: await verifyModel(m.id) })))
    for (const r of results) {
      if (r.ok) verified.add(r.id)
      else console.log(`[ModelVerify] ${r.id}: not accessible with current credentials`)
    }
  }
  console.log(`[ModelVerify] ${verified.size}/${models.length} models verified`)
  return verified
}

async function ensureVerified(models: ModelInfo[]): Promise<Set<string>> {
  if (_verifiedModels && Date.now() - _verifiedModels.verifiedAt < VERIFIED_CACHE_TTL) {
    return _verifiedModels.ids
  }
  if (!_verificationPromise) {
    _verificationPromise = runVerification(models)
      .then(ids => {
        _verifiedModels = { ids, verifiedAt: Date.now() }
        _verificationPromise = null
        return ids
      })
      .catch(e => {
        console.warn("[ModelVerify] Verification failed:", e)
        _verificationPromise = null
        return new Set<string>(models.map(m => m.id))
      })
  }
  return _verificationPromise
}

export async function fetchAvailableModels(): Promise<ModelInfo[]> {
  let models: ModelInfo[]
  if (_modelsCache && Date.now() - _modelsCache.fetchedAt < MODELS_CACHE_TTL) {
    models = _modelsCache.models
  } else {
    try {
      const res = await fetchWithTimeout(`${PROXY_BASE_URL}/v1/models`, {
        headers: { Authorization: `Bearer ${process.env.PROXY_API_KEY || "sk-dummy"}` },
      })
      if (!res.ok) throw new Error(`Models endpoint returned ${res.status}`)
      const data = await res.json() as { data: ModelInfo[] }
      models = data.data || []
      _modelsCache = { models, fetchedAt: Date.now() }
    } catch (e) {
      console.warn("Could not fetch models from proxy:", e)
      return _modelsCache?.models ?? []
    }
  }

  const verified = await ensureVerified(models)
  return models.filter(m => verified.has(m.id))
}

export function invalidateVerifiedModels(): void {
  _verifiedModels = null
  _verificationPromise = null
  _modelsCache = null
}

export function isProxyAvailable(): Promise<boolean> {
  if (_modelsCache && Date.now() - _modelsCache.fetchedAt < MODELS_CACHE_TTL) {
    return Promise.resolve(true)
  }
  return fetchWithTimeout(`${PROXY_BASE_URL}/v1/models`, {
    method: "GET",
    headers: { Authorization: `Bearer ${process.env.PROXY_API_KEY || "sk-dummy"}` },
  }).then(res => res.ok).catch(() => false)
}

export async function chatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResponse> {
  const limiter = getRateLimiter(options.model)
  const startTime = Date.now()
  const promptPreview = options.messages[options.messages.length - 1]?.content?.slice(0, 80) || ""
  log.llm(`→ ${options.model}`, `"${promptPreview}..."`)

  for (let attempt = 0; attempt <= RETRY_BACKOFFS.length; attempt++) {
    try {
      await limiter.acquire()

      const res = await fetchWithTimeout(`${PROXY_BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.PROXY_API_KEY || "sk-dummy"}`,
        },
        body: JSON.stringify({
          model: options.model,
          messages: options.messages,
          temperature: options.temperature ?? 0.7,
          max_tokens: options.max_tokens,
          stream: false,
          ...(options.tools?.length ? { tools: options.tools, tool_choice: options.tool_choice ?? "auto" } : {}),
        }),
      })

      if (!res.ok) {
        const body = await res.text()
        // 429 = rate limited — always retry
        if (res.status === 429 || res.status >= 500) {
          throw new Error(`HTTP ${res.status}: ${body}`)
        }
        throw new Error(`HTTP ${res.status}: ${body}`)
      }

      const result = await res.json() as ChatCompletionResponse
      const elapsed = Date.now() - startTime
      const tokens = result.usage
        ? `${result.usage.prompt_tokens}→${result.usage.completion_tokens} tok`
        : "no usage data"
      log.llm(`← ${options.model} ${elapsed}ms`, tokens)
      return result
    } catch (e) {
      if (attempt < RETRY_BACKOFFS.length) {
        log.error("LLM", `attempt ${attempt + 1} failed, retrying in ${RETRY_BACKOFFS[attempt]}ms`, e)
        await new Promise(r => setTimeout(r, RETRY_BACKOFFS[attempt]))
      } else {
        throw e
      }
    }
  }

  throw new Error("Unreachable")
}

export async function chatCompletionText(options: ChatCompletionOptions): Promise<string> {
  const res = await chatCompletion(options)
  const msg = res.choices[0]?.message
  const content = msg?.content ?? ""
  // Null content with no tool calls = model refused or failed — treat as retryable error
  if (!content && msg && !msg.tool_calls?.length) {
    log.error("LLM", `chatCompletionText: null content from ${options.model} — treating as failure`)
    throw new Error(`Model ${options.model} returned null content with no tool calls`)
  }
  return content
}

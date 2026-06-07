import { fetchAvailableModels } from "./proxyClient"

const MODELS_URLS = [
  "https://models.router-for.me/models.json",
  "https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/models.json",
]
const REFRESH_INTERVAL = 3 * 60 * 60 * 1000 // 3 hours
const FETCH_TIMEOUT = 30_000

export type ModelTier = "fast" | "balanced" | "powerful"

export interface ModelMeta {
  id: string
  display_name: string
  description: string
  context_length: number
  max_completion_tokens: number
  type: string
  thinking: { min?: number; max?: number; levels?: string[]; zero_allowed?: boolean } | null
  supports_tools: boolean
  tier: ModelTier
}

export interface CatalogEntry extends ModelMeta {
  available: boolean
}

// ── In-memory cache ──

let catalog = new Map<string, ModelMeta>()
let refreshTimer: ReturnType<typeof setInterval> | null = null

// ── Tier derivation ──

function deriveTier(id: string): ModelTier {
  const low = id.toLowerCase()
  if (/haiku|mini|spark|3-5-haiku|flash/.test(low)) return "fast"
  if (/opus|codex-max|gpt-5\.4/.test(low)) return "powerful"
  return "balanced"
}

// ── Parse raw JSON ──

interface RawModel {
  id: string
  display_name?: string
  description?: string
  context_length?: number
  max_completion_tokens?: number
  type?: string
  thinking?: { min?: number; max?: number; levels?: string[]; zero_allowed?: boolean }
  supported_parameters?: string[]
  // gemini variants
  inputTokenLimit?: number
  outputTokenLimit?: number
  displayName?: string
  name?: string
}

function parseModel(raw: RawModel): ModelMeta {
  const id = raw.id ?? raw.name ?? ""
  const type = raw.type ?? ""
  const supportedParams = raw.supported_parameters ?? []
  const supports_tools = supportedParams.includes("tools") || type === "claude"
  const thinking = raw.thinking ?? null

  return {
    id,
    display_name: raw.display_name ?? raw.displayName ?? id,
    description: raw.description ?? "",
    context_length: raw.context_length ?? raw.inputTokenLimit ?? 0,
    max_completion_tokens: raw.max_completion_tokens ?? raw.outputTokenLimit ?? 0,
    type,
    thinking,
    supports_tools,
    tier: deriveTier(id),
  }
}

function flattenSections(data: Record<string, RawModel[]>): Map<string, ModelMeta> {
  const map = new Map<string, ModelMeta>()
  for (const models of Object.values(data)) {
    if (!Array.isArray(models)) continue
    for (const raw of models) {
      const m = parseModel(raw)
      if (m.id && !map.has(m.id)) map.set(m.id, m)
    }
  }
  return map
}

// ── Fetch from remote ──

async function fetchRemoteCatalog(): Promise<Map<string, ModelMeta> | null> {
  for (const url of MODELS_URLS) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT)
      const res = await fetch(url, { signal: controller.signal })
      clearTimeout(timer)
      if (!res.ok) continue
      const data = await res.json()
      const map = flattenSections(data)
      if (map.size > 0) {
        console.log(`[ModelCatalog] Loaded ${map.size} models from ${url}`)
        return map
      }
    } catch (e) {
      console.warn(`[ModelCatalog] Fetch failed from ${url}: ${e}`)
    }
  }
  return null
}

async function refresh(): Promise<void> {
  const next = await fetchRemoteCatalog()
  if (next) catalog = next
}

// ── Public API ──

export async function startModelCatalog(): Promise<void> {
  await refresh()
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = setInterval(() => void refresh(), REFRESH_INTERVAL)
}

export function getModelMeta(modelId: string): ModelMeta | null {
  return catalog.get(modelId) ?? null
}

export function getAllModelMeta(): ModelMeta[] {
  return Array.from(catalog.values())
}

export async function getModelCatalog(): Promise<CatalogEntry[]> {
  const available = await fetchAvailableModels()
  const availableIds = new Set(available.map(m => m.id))

  return getAllModelMeta().map(m => ({
    ...m,
    available: availableIds.has(m.id),
  }))
}

// ── Smart default resolution ──

export type TaskProfile = "fast" | "balanced" | "deep_reasoning"

const PREFERENCE_ORDER: Record<TaskProfile, ModelTier[]> = {
  fast:           ["fast", "balanced", "powerful"],
  balanced:       ["balanced", "fast", "powerful"],
  deep_reasoning: ["powerful", "balanced", "fast"],
}

export async function resolveSmartDefault(profile: TaskProfile): Promise<string | null> {
  const available = await fetchAvailableModels()
  const availableIds = new Set(available.map(m => m.id))
  const allMeta = getAllModelMeta().filter(m => availableIds.has(m.id))
  if (allMeta.length === 0) return null

  const tierOrder = PREFERENCE_ORDER[profile]
  for (const tier of tierOrder) {
    const candidates = allMeta.filter(m => m.tier === tier)
    if (candidates.length > 0) {
      // Prefer Claude, then OpenAI, then others
      const claude = candidates.find(m => m.type === "claude")
      if (claude) return claude.id
      const openai = candidates.find(m => m.type === "openai")
      if (openai) return openai.id
      return candidates[0].id
    }
  }

  return allMeta[0].id
}

export function getSmartDefaultSync(profile: TaskProfile): { modelId: string; displayName: string } | null {
  const allMeta = getAllModelMeta()
  if (allMeta.length === 0) return null

  const tierOrder = PREFERENCE_ORDER[profile]
  for (const tier of tierOrder) {
    const candidates = allMeta.filter(m => m.tier === tier)
    if (candidates.length > 0) {
      const claude = candidates.find(m => m.type === "claude")
      if (claude) return { modelId: claude.id, displayName: claude.display_name }
      const openai = candidates.find(m => m.type === "openai")
      if (openai) return { modelId: openai.id, displayName: openai.display_name }
      return { modelId: candidates[0].id, displayName: candidates[0].display_name }
    }
  }
  return { modelId: allMeta[0].id, displayName: allMeta[0].display_name }
}

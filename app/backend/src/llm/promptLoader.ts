import { join } from "path"
import { readFileSync } from "fs"
import { getPromptConfig, getTaskProfile } from "../db/queries/promptConfigs"
import { TOOL_REGISTRY } from "./toolDefinitions"
import { resolveSmartDefault } from "./modelCatalog"
import { fetchAvailableModels } from "./proxyClient"
import type { ToolDefinition } from "./proxyClient"

const cache = new Map<string, string>()

const PROMPTS_DIR = join(import.meta.dir, "../../prompts")

export function loadPrompt(name: string, vars?: Record<string, string>): string {
  if (!cache.has(name)) {
    const path = join(PROMPTS_DIR, name + ".md")
    cache.set(name, readFileSync(path, "utf-8").trim())
  }
  let prompt = cache.get(name)!
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      prompt = prompt.replaceAll(`{${k}}`, v)
    }
  }
  return prompt
}

export interface ResolvedPrompt {
  content: string
  model: string | null
  tools: ToolDefinition[]
}

export async function resolvePrompt(name: string, vars?: Record<string, string>): Promise<ResolvedPrompt> {
  const content = loadPrompt(name, vars)
  const config = getPromptConfig(name)
  const tools = config.tools
    .map(t => TOOL_REGISTRY[t])
    .filter((t): t is ToolDefinition => !!t)

  // Model resolution: explicit override > smart default > null (caller fallback)
  let model = config.model
  if (model) {
    const available = await fetchAvailableModels()
    const availableIds = new Set(available.map(m => m.id))
    if (!availableIds.has(model)) {
      console.warn(`[PromptLoader] Model "${model}" configured for "${name}" is not available, falling back to smart default`)
      model = null
    }
  }
  if (!model) {
    const profile = getTaskProfile(name)
    if (profile) {
      model = await resolveSmartDefault(profile)
    }
  }

  return { content, model, tools }
}

export function clearPromptCache(): void {
  cache.clear()
}

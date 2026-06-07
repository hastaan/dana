const BASE = "/api"

export interface Topic {
  id: string
  title: string
  description: string
  created_at: string
  updated_at: string
  status: string
  current_version: number
  models: Record<string, string>
  settings: Record<string, unknown>
}

export interface AnalystGuidance {
  framing_note?: string
  research_guidance?: string
  evidence_guidance?: string
  debate_guidance?: string
}

export interface AppSettings {
  default_models: Record<string, string>
  analysis_controls: Record<string, number>
  steering?: AnalystGuidance
}

export interface ForecastResolution {
  topic_id: string
  version: number
  resolved_scenario_id: string
  resolved_at: string
  notes: string | null
  brier_score: number
  log_score: number | null
  forecast: { scenario_id: string; title: string; probability: number }[]
}

export interface CalibrationSummary {
  count: number
  mean_brier: number | null
  mean_log_score: number | null
  resolutions: (ForecastResolution & { topic_title?: string })[]
  reliability: { bucket: string; predicted_mean: number; observed_rate: number; n: number }[]
}

export interface CustomProvider {
  kind: "openai" | "anthropic"
  id: string
  name: string
  base_url: string
  models: { name: string; alias?: string }[]
  key_hint: string
  disabled?: boolean
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }))
    throw new Error((err as any).message || res.statusText)
  }
  return res.json()
}

export const api = {
  topics: {
    list: () => request<Topic[]>("/topics"),
    get: (id: string) => request<Topic>(`/topics/${id}`),
    create: (data: { title: string; description: string }) =>
      request<Topic>("/topics", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, patch: Partial<Topic>) =>
      request<Topic>(`/topics/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
    delete: (id: string) =>
      request<{ success: boolean }>(`/topics/${id}`, { method: "DELETE" }),
    getSteering: (id: string) =>
      request<{ steering: AnalystGuidance }>(`/topics/${id}/steering`),
    putSteering: (id: string, steering: AnalystGuidance) =>
      request<{ steering: AnalystGuidance }>(`/topics/${id}/steering`, { method: "PUT", body: JSON.stringify({ steering }) }),
  },
  expertCouncil: {
    get: (topicId: string) => request<any>(`/topics/${topicId}/expert-council`),
    getVersion: (topicId: string, version: number) => request<any>(`/topics/${topicId}/expert-council/${version}`),
  },
  verdict: {
    get: (topicId: string) => request<any>(`/topics/${topicId}/verdict`),
    getVersion: (topicId: string, version: number) => request<any>(`/topics/${topicId}/verdict/${version}`),
  },
  pipeline: {
    discover: (topicId: string) =>
      request<{ run_id: string; started_at: string; status: string }>(
        `/topics/${topicId}/pipeline/discover`, { method: "POST" }
      ),
    enrich: (topicId: string) =>
      request<{ run_id: string; started_at: string; status: string }>(
        `/topics/${topicId}/pipeline/enrich`, { method: "POST" }
      ),
    analyze: (topicId: string) =>
      request<{ run_id: string; started_at: string; status: string }>(
        `/topics/${topicId}/pipeline/analyze`, { method: "POST" }
      ),
    forumPrep: (topicId: string) =>
      request<{ run_id: string; started_at: string; status: string }>(
        `/topics/${topicId}/pipeline/forum-prep`, { method: "POST" }
      ),
    forum: (topicId: string) =>
      request<{ run_id: string; started_at: string; status: string }>(
        `/topics/${topicId}/pipeline/forum`, { method: "POST" }
      ),
    score: (topicId: string) =>
      request<{ run_id: string; started_at: string; status: string }>(
        `/topics/${topicId}/pipeline/score`, { method: "POST" }
      ),
    run: (topicId: string) =>
      request<{ run_id: string; started_at: string; status: string }>(
        `/topics/${topicId}/pipeline/run`, { method: "POST" }
      ),
    update: (topicId: string) =>
      request<{ run_id: string; started_at: string; status: string }>(
        `/topics/${topicId}/pipeline/update`, { method: "POST" }
      ),
    reanalyze: (topicId: string) =>
      request<{ run_id: string; started_at: string; status: string }>(
        `/topics/${topicId}/pipeline/reanalyze`, { method: "POST" }
      ),
    status: (topicId: string) =>
      request<{ running: boolean; run_id?: string; started_at?: string }>(
        `/topics/${topicId}/pipeline/status`
      ),
  },
  states: {
    list: (topicId: string) => request<Array<{
      version: number
      label: string
      version_status: string
      completed_stages: string[]
      fork_stage: string | null
      delta_from: number | null
    }>>(`/topics/${topicId}/states`),
  },
  representatives: {
    list: (topicId: string, version?: number) =>
      request<any[]>(`/topics/${topicId}/representatives${version ? `?version=${version}` : ""}`),
  },
  parties: {
    list: (topicId: string, version?: number) =>
      request<any[]>(`/topics/${topicId}/parties${version ? `?version=${version}` : ""}`),
    update: (topicId: string, partyId: string, data: Record<string, unknown>) =>
      request<any>(`/topics/${topicId}/parties/${partyId}`, { method: "PUT", body: JSON.stringify(data) }),
    delete: (topicId: string, partyId: string) =>
      request<{ success: boolean }>(`/topics/${topicId}/parties/${partyId}`, { method: "DELETE" }),
    add: (topicId: string, data: Record<string, unknown>) =>
      request<any>(`/topics/${topicId}/parties`, { method: "POST", body: JSON.stringify(data) }),
    merge: (topicId: string, sourceIds: string[], target: Record<string, unknown>) =>
      request<any>(`/topics/${topicId}/parties/merge`, {
        method: "POST", body: JSON.stringify({ source_ids: sourceIds, target }),
      }),
    smartAdd: (topicId: string, name: string) =>
      request<any>(`/topics/${topicId}/parties/smart-add`, {
        method: "POST", body: JSON.stringify({ name }),
      }),
    smartEdit: (topicId: string, partyId: string, feedback: string) =>
      request<any>(`/topics/${topicId}/parties/${partyId}/smart-edit`, {
        method: "POST", body: JSON.stringify({ feedback }),
      }),
    split: (topicId: string, sourceId: string, into: { name: string }[]) =>
      request<{ removed: string; created: any[] }>(`/topics/${topicId}/parties/split`, {
        method: "POST", body: JSON.stringify({ source_id: sourceId, into }),
      }),
  },
  clues: {
    list: (topicId: string, version?: number) =>
      request<any[]>(`/topics/${topicId}/clues${version ? `?version=${version}` : ""}`),
    smartAdd: (topicId: string, query: string) =>
      request<{ imported: number; clues: any[]; query: string }>(`/topics/${topicId}/clues/research`, {
        method: "POST", body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(600_000),
      }),
    update: (topicId: string, clueId: string, data: Record<string, unknown>) =>
      request<any>(`/topics/${topicId}/clues/${clueId}`, { method: "PUT", body: JSON.stringify(data) }),
    delete: (topicId: string, clueId: string) =>
      request<{ success: boolean }>(`/topics/${topicId}/clues/${clueId}`, { method: "DELETE" }),
    smartEdit: (topicId: string, clueId: string, feedback: string) =>
      request<any>(`/topics/${topicId}/clues/smart-edit/${clueId}`, {
        method: "POST", body: JSON.stringify({ feedback }),
      }),
    bulkImportStart: (topicId: string, content: string) =>
      request<{ status: string }>(`/topics/${topicId}/clues/bulk`, {
        method: "POST", body: JSON.stringify({ content }),
      }),
    bulkImportStatus: (topicId: string) =>
      request<{ status: string; stored?: number; updated?: number; skipped?: number; error?: string }>(`/topics/${topicId}/clues/bulk/status`),
    updateAllStart: (topicId: string) =>
      request<{ status: string }>(`/topics/${topicId}/clues/update-all`, { method: "POST" }),
    updateAllStatus: (topicId: string) =>
      request<{ status: string; checked?: number; updated?: number; error?: string }>(`/topics/${topicId}/clues/update-all/status`),
    research: (topicId: string, query: string) =>
      request<{ imported: number; clues: any[]; query: string }>(`/topics/${topicId}/clues/research`, {
        method: "POST", body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(600_000),
      }),
    cleanupStart: (topicId: string) =>
      request<{ status: string }>(`/topics/${topicId}/clues/cleanup/propose`, { method: "POST" }),
    cleanupStatus: (topicId: string) =>
      request<{ status: string; groups?: any[]; original_count?: number; error?: string }>(`/topics/${topicId}/clues/cleanup/status`),
    cleanupApply: (topicId: string, groups: any[]) =>
      request<{ original_count: number; merged: number; deleted: number; final_count: number }>(
        `/topics/${topicId}/clues/cleanup/apply`,
        { method: "POST", body: JSON.stringify({ groups }) },
      ),
  },
  settings: {
    get: () => request<AppSettings>("/settings"),
    update: (data: Partial<AppSettings>) =>
      request<AppSettings>("/settings", { method: "PUT", body: JSON.stringify(data) }),
  },
  prompts: {
    list: () => request<Array<{ name: string; path: string; content: string; agent: string; variables: string[]; stage: string; model: string | null; tools: string[]; task_profile: string | null }>>("/prompts"),
    get: (name: string) => request<{ name: string; path: string; content: string; agent: string; variables: string[]; stage: string; model: string | null; tools: string[]; task_profile: string | null }>(`/prompts/${encodeURIComponent(name)}`),
    update: (name: string, content: string) =>
      request<{ name: string; path: string; content: string; agent: string; variables: string[]; stage: string; model: string | null; tools: string[]; task_profile: string | null }>(`/prompts/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: JSON.stringify({ content }),
      }),
    reset: (name: string) =>
      request<{ name: string; path: string; content: string; agent: string; variables: string[]; stage: string; model: string | null; tools: string[]; task_profile: string | null }>(`/prompts/${encodeURIComponent(name)}/reset`, {
        method: "POST",
      }),
    updateConfig: (name: string, config: { model?: string | null; tools?: string[] }) =>
      request<{ name: string; model: string | null; tools: string[] }>(`/prompts/${encodeURIComponent(name)}/config`, {
        method: "PUT",
        body: JSON.stringify(config),
      }),
    toolCatalog: () => request<Array<{ name: string; description: string; category: string }>>("/prompts/tool-catalog"),
  },
  providers: {
    list: () => request<{ providers: Array<{ provider: string; label: string; status: string; account: string | null; credential_file: string }> }>("/providers"),
    login: (provider: string) => request<{ provider: string; oauth_url: string | null; status: string }>("/providers/login", { method: "POST", body: JSON.stringify({ provider }) }),
    loginStatus: (provider: string) => request<{ provider: string; connected: boolean; timeout: boolean; oauth_url?: string | null; error?: string | null }>(`/providers/login/status?provider=${encodeURIComponent(provider)}`),
    disconnect: (provider: string) => request<{ provider: string; removed: number }>(`/providers/${provider}`, { method: "DELETE" }),
    models: () => request<{ providers: Array<{ provider: string; models: string[] }> }>("/providers/models"),
    statuses: () => request<{ providers: Array<{ provider: string; connected: boolean; account?: string | null }> }>("/providers"),
    health: () => request<{ proxy_online: boolean; connected_providers: string[]; model_count: number; credential_files: number }>("/providers/health"),
  },
  customProviders: {
    list: () => request<{ providers: CustomProvider[] }>("/providers/custom"),
    status: () => request<{ available: boolean; reason?: string }>("/providers/custom/status"),
    upsert: (data: {
      kind: "openai" | "anthropic"
      name?: string
      base_url: string
      api_key?: string
      models?: { name: string; alias?: string }[]
    }) => request<{ ok: boolean }>("/providers/custom", { method: "POST", body: JSON.stringify(data) }),
    remove: (kind: "openai" | "anthropic", id: string) =>
      request<{ ok: boolean }>(`/providers/custom?kind=${kind}&id=${encodeURIComponent(id)}`, { method: "DELETE" }),
  },
  calibration: {
    get: () => request<CalibrationSummary>("/calibration"),
  },
  resolution: {
    get: (topicId: string, version?: number) =>
      request<{ resolution: ForecastResolution | null }>(`/topics/${topicId}/resolution${version != null ? `?version=${version}` : ""}`),
    resolve: (topicId: string, resolved_scenario_id: string, opts?: { version?: number; notes?: string }) =>
      request<{ ok: boolean; version: number; brier_score: number; log_score: number }>(`/topics/${topicId}/resolve`, {
        method: "POST", body: JSON.stringify({ resolved_scenario_id, ...opts }),
      }),
    clear: (topicId: string, version?: number) =>
      request<{ ok: boolean }>(`/topics/${topicId}/resolution${version != null ? `?version=${version}` : ""}`, { method: "DELETE" }),
  },
  models: {
    list: () => request<{ id: string }[]>("/models"),
    catalog: () => request<Array<{
      id: string
      display_name: string
      description: string
      context_length: number
      max_completion_tokens: number
      type: string
      thinking: { min?: number; max?: number; levels?: string[]; zero_allowed?: boolean } | null
      supports_tools: boolean
      tier: "fast" | "balanced" | "powerful"
      available: boolean
    }>>("/models/catalog"),
  },
}

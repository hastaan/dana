import { useEffect, useMemo, useState } from "react"

import { ChevronDown, ChevronRight, Search, Plug, RotateCcw, ExternalLink, FileText, Check, Wrench, Brain, Zap, Gauge, Cpu, Plus, Trash2, Pencil, KeyRound } from "lucide-react"
import { useNavigate, useParams } from "react-router-dom"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { api, type CustomProvider } from "@/api/client"
import { SteeringPanel } from "@/components/Topic/SteeringPanel"
import { CalibrationCard } from "@/components/CalibrationCard"

type CatalogModel = Awaited<ReturnType<typeof api.models.catalog>>[number]

const tabMap = {
  providers: { label: "Providers", description: "Connect LLM providers." },
  prompts: { label: "System Prompts", description: "Configure prompts, models, and tools." },
  pipeline: { label: "Analysis Controls", description: "Configure research depth, parallelism, and debate behavior." },
} as const

type TabKey = keyof typeof tabMap
type ProviderId = "claude" | "openai" | "gemini"

type ProviderState = {
  provider: ProviderId
  label: string
  description: string
  icon: typeof Plug
  status: "disconnected" | "connecting" | "connected" | "error"
  account?: string | null
  models: string[]
}

const STORAGE_KEY = "dana.settings.activeTab"
const CATALOG_CACHE_KEY = "dana.settings.catalogCache"
const CATALOG_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

type CatalogCache = { models: CatalogModel[]; ts: number }

function readCatalogCache(): CatalogModel[] {
  try {
    const raw = localStorage.getItem(CATALOG_CACHE_KEY)
    if (!raw) return []
    const parsed: CatalogCache = JSON.parse(raw)
    if (Date.now() - parsed.ts > CATALOG_CACHE_TTL) return []
    return parsed.models
  } catch { return [] }
}

function writeCatalogCache(models: CatalogModel[]): void {
  try { localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify({ models, ts: Date.now() })) } catch { /* ignore */ }
}

const CONTROLS_DEFAULTS = {
  discovery_research_iterations: 5,
  discovery_context_warning: 120000,
  scoring_iterations: 3,
  scoring_context_warning: 100000,
  scoring_batch_size: 2,
  scoring_ensemble_runs: 1,
  enrichment_iterations: 8,
  enrichment_context_warning: 100000,
  enrichment_batch_size: 2,
  enrichment_max_searches_per_round: 3,
  enrichment_max_fetches_per_round: 5,
  fact_check_iterations: 3,
  smart_extract_url_limit: 10,
  research_search_queries: 4,
  smart_edit_queries: 3,
  smart_edit_max_chars: 15000,
  bulk_import_iterations: 5,
  bulk_import_chunk_target_chars: 2000,
  bulk_import_chunk_max_chars: 4000,
  bulk_fact_check_iterations: 2,
  evidence_update_batch_size: 3,
  evidence_update_iterations: 3,
  cleanup_fact_check_iterations: 2,
  forum_max_turns: 60,
  forum_compress_interval: 10,
  forum_speaking_budget: 600,
  forum_scenario_update_interval: 5,
  forum_min_turns_multiplier: 2.5,
  default_max_iterations: 5,
  default_context_warning: 150000,
  max_fetch_chars: 10000,
  corpus_cache_hours: 24,
}

function readStoredTab(): TabKey {
  if (typeof window === "undefined") return "providers"
  const value = window.localStorage.getItem(STORAGE_KEY)
  return value && value in tabMap ? (value as TabKey) : "providers"
}

function resolveTab(tab?: string): TabKey {
  if (tab && tab in tabMap) return tab as TabKey
  return readStoredTab()
}

export function SettingsPage() {
  const { tab } = useParams()
  const navigate = useNavigate()
  const activeTab = useMemo(() => resolveTab(tab), [tab])
  const [catalogModels, setCatalogModels] = useState<CatalogModel[]>(() => readCatalogCache())

  const refreshCatalog = async () => {
    try {
      const models = await api.models.catalog()
      setCatalogModels(models)
      writeCatalogCache(models)
    } catch { /* ignore */ }
  }

  useEffect(() => {
    if (tab && !(tab in tabMap)) { navigate("/settings", { replace: true }); return }
    if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, activeTab)
  }, [activeTab, navigate, tab])

  // Load catalog on mount only if cache is empty
  useEffect(() => {
    if (catalogModels.length === 0) void refreshCatalog()
  }, [])

  const setTab = (value: string) => {
    const next = value as TabKey
    if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, next)
    navigate(next === "providers" ? "/settings" : `/settings/${next}`)
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">Configure providers, prompts, and pipeline settings.</p>
      </div>
      <Tabs value={activeTab} onValueChange={setTab} className="space-y-4">
        <TabsList className="grid h-auto w-full grid-cols-3 gap-2 p-1">
          {Object.entries(tabMap).map(([value, meta]) => (
            <TabsTrigger key={value} value={value} className="h-full min-h-12 px-4 py-3">{meta.label}</TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="providers" className="mt-0">
        <div className="space-y-6">
          <ProvidersPanel catalogModels={catalogModels} onRefreshCatalog={refreshCatalog} />
          <CustomProvidersCard onRefreshCatalog={refreshCatalog} />
        </div>
      </TabsContent>
        <TabsContent value="prompts" className="mt-0"><PromptsPanel catalogModels={catalogModels} /></TabsContent>
        <TabsContent value="pipeline" className="mt-0">
          <div className="space-y-6">
            <SteeringPanel />
            <CalibrationCard />
            <PipelinePanel />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ── Providers Panel (connections + available models) ──────────────────────

type HealthStatus = { proxy_online: boolean; connected_providers: string[]; model_count: number; credential_files: number } | null

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

function thinkingLabel(thinking: CatalogModel["thinking"]): string | null {
  if (!thinking) return null
  if (thinking.levels?.length) {
    const levels = thinking.levels
    if (levels.length === 1) return levels[0]
    return `${levels[0]}\u2192${levels[levels.length - 1]}`
  }
  if (thinking.min != null || thinking.max != null) return "budget"
  return null
}

const tierConfig = {
  fast: { label: "Fast", color: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/30", icon: Zap },
  balanced: { label: "Balanced", color: "text-blue-600 dark:text-blue-400 bg-blue-500/10 border-blue-500/30", icon: Gauge },
  powerful: { label: "Powerful", color: "text-purple-600 dark:text-purple-400 bg-purple-500/10 border-purple-500/30", icon: Cpu },
} as const

function TierBadge({ tier }: { tier: CatalogModel["tier"] }) {
  const cfg = tierConfig[tier]
  const Icon = cfg.icon
  return <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium", cfg.color)}><Icon className="size-2.5" />{cfg.label}</span>
}

function ModelCard({ model }: { model: CatalogModel }) {
  const think = thinkingLabel(model.thinking)
  return (
    <div className="rounded-lg border border-border/70 bg-background/70 px-3 py-2.5 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium truncate">{model.display_name}</span>
        <TierBadge tier={model.tier} />
      </div>
      <div className="text-[11px] text-muted-foreground font-mono truncate">{model.id}</div>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        {model.context_length > 0 && <span>{formatTokens(model.context_length)} ctx</span>}
        {model.max_completion_tokens > 0 && <span>{formatTokens(model.max_completion_tokens)} out</span>}
        {think && <span className="inline-flex items-center gap-0.5"><Brain className="size-2.5" />{think}</span>}
        {model.supports_tools && <span className="inline-flex items-center gap-0.5"><Wrench className="size-2.5" />tools</span>}
      </div>
      {model.description && <div className="text-[11px] text-muted-foreground/70 line-clamp-1">{model.description}</div>}
    </div>
  )
}

function ProvidersPanel({ catalogModels, onRefreshCatalog }: { catalogModels: CatalogModel[]; onRefreshCatalog: () => Promise<void> }) {
  const [providers, setProviders] = useState<ProviderState[]>([
    { provider: "claude", label: "Claude / Anthropic", description: "Claude models for analysis and reasoning.", icon: Plug, status: "disconnected", models: [] },
    { provider: "openai", label: "OpenAI / Codex", description: "OpenAI and Codex-compatible models.", icon: ExternalLink, status: "disconnected", models: [] },
    { provider: "gemini", label: "Google Gemini", description: "Gemini models for general-purpose reasoning.", icon: ExternalLink, status: "disconnected", models: [] },
  ])
  const [login, setLogin] = useState<{ provider: ProviderId; oauthUrl: string | null } | null>(null)
  const [health, setHealth] = useState<HealthStatus>(null)
  const [healthLoading, setHealthLoading] = useState(false)

  const loadHealth = async () => {
    setHealthLoading(true)
    try { setHealth(await api.providers.health()) } catch { setHealth({ proxy_online: false, connected_providers: [], model_count: 0, credential_files: 0 }) } finally { setHealthLoading(false) }
  }

  const loadProviders = async () => {
    const [connections, modelGroups] = await Promise.all([api.providers.list(), api.providers.models()])
    setProviders(cur => cur.map(p => {
      const conn = connections.providers.find(i => i.provider === p.provider)
      const grp = modelGroups.providers.find(i => i.provider === p.provider)
      return { ...p, status: conn ? "connected" : "disconnected", account: conn?.account ?? null, models: grp?.models ?? [] }
    }))
  }

  const refreshAll = async () => { await Promise.all([loadProviders(), loadHealth(), onRefreshCatalog()]) }
  useEffect(() => { void Promise.all([loadProviders(), loadHealth()]) }, [])

  const availableModels = useMemo(() => catalogModels.filter(m => m.available), [catalogModels])
  const groupedAvailable = useMemo(() => {
    const map = new Map<string, CatalogModel[]>()
    for (const m of availableModels) {
      const key = m.type || "other"
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(m)
    }
    // Sort: claude first, then openai, then rest
    const order = ["claude", "openai", "gemini"]
    return Array.from(map.entries()).sort((a, b) => {
      const ai = order.indexOf(a[0]), bi = order.indexOf(b[0])
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
    })
  }, [availableModels])

  const providerLabel: Record<string, string> = { claude: "Anthropic", openai: "OpenAI / Codex", gemini: "Google Gemini" }

  const connectProvider = async (providerId: string) => {
    setProviders(cur => cur.map(p => p.provider === providerId ? { ...p, status: "connecting" as const } : p))
    try {
      const res = await api.providers.login(providerId)
      if (res.oauth_url) setLogin({ provider: providerId as ProviderId, oauthUrl: res.oauth_url })
      const poll = setInterval(async () => {
        try {
          const status = await api.providers.loginStatus(providerId)
          if (status.oauth_url) setLogin({ provider: providerId as ProviderId, oauthUrl: status.oauth_url })
          if (status.connected) { clearInterval(poll); setLogin(null); await refreshAll(); return }
          if (status.timeout) { clearInterval(poll); setLogin(null); setProviders(cur => cur.map(p => p.provider === providerId ? { ...p, status: "error" as const } : p)) }
        } catch { clearInterval(poll); setLogin(null); setProviders(cur => cur.map(p => p.provider === providerId ? { ...p, status: "error" as const } : p)) }
      }, 2000)
    } catch { setProviders(cur => cur.map(p => p.provider === providerId ? { ...p, status: "error" as const } : p)) }
  }

  const disconnectProvider = async (providerId: string) => { await api.providers.disconnect(providerId); await refreshAll() }

  return (
    <Card className="border-border/70 bg-card/80">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div><CardTitle>Providers</CardTitle><CardDescription>Connect LLM providers to unlock model access for all prompts.</CardDescription></div>
          <Button variant="outline" size="sm" onClick={() => void refreshAll()} disabled={healthLoading}>
            <RotateCcw className={cn("mr-2 size-4", healthLoading && "animate-spin")} />{healthLoading ? "Checking..." : "Refresh"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {health && (
          <div className={cn("flex items-center justify-between rounded-lg border p-3 text-sm", health.proxy_online ? "border-emerald-500/40 bg-emerald-500/10" : "border-destructive/40 bg-destructive/10")}>
            <div className="flex items-center gap-2">
              <div className={cn("size-2 rounded-full", health.proxy_online ? "bg-emerald-500" : "bg-destructive")} />
              <span className={health.proxy_online ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"}>{health.proxy_online ? "LLM proxy online" : "LLM proxy offline"}</span>
            </div>
            <div className="flex items-center gap-4 text-muted-foreground">
              <span>{health.credential_files} credential{health.credential_files !== 1 ? "s" : ""}</span>
              <span>{availableModels.length} model{availableModels.length !== 1 ? "s" : ""}</span>
            </div>
          </div>
        )}
        <div className="grid gap-4 md:grid-cols-3">
          {providers.map(p => (
            <Card key={p.provider} className="border-border/70 bg-background/70">
              <CardHeader className="space-y-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{p.label}</CardTitle>
                  <Badge variant={p.status === "connected" ? "default" : "secondary"}>{p.status === "connected" ? "Connected" : p.status === "connecting" ? "Connecting..." : p.status === "error" ? "Error" : "Disconnected"}</Badge>
                </div>
                <CardDescription>{p.description}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {p.status === "connected" && p.account && <div className="text-sm text-muted-foreground">Account: {p.account}</div>}
                {p.status === "connected" && <div className="text-sm text-muted-foreground">{p.models.length} models available</div>}
                {p.status === "connected" ? (
                  <Button variant="outline" size="sm" className="w-full" onClick={() => void disconnectProvider(p.provider)}>Disconnect</Button>
                ) : (
                  <Button size="sm" className="w-full" onClick={() => void connectProvider(p.provider)} disabled={p.status === "connecting"}>{p.status === "connecting" ? "Connecting..." : "Connect"}</Button>
                )}
                {p.status === "error" && <div className="text-sm text-destructive">Connection failed. Try again.</div>}
              </CardContent>
            </Card>
          ))}
        </div>
        {groupedAvailable.length > 0 && (
          <>
            <Separator />
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">Available Models</div>
                <div className="text-xs text-muted-foreground">{availableModels.length} models across {groupedAvailable.length} provider{groupedAvailable.length !== 1 ? "s" : ""}</div>
              </div>
              <ScrollArea className="max-h-[420px] rounded-md border border-border/70 bg-background/50 p-3">
                <div className="space-y-4">
                  {groupedAvailable.map(([type, models]) => (
                    <div key={type}>
                      <div className="px-1 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{providerLabel[type] ?? type}</div>
                      <div className="grid gap-2 sm:grid-cols-2">{models.map(m => <ModelCard key={m.id} model={m} />)}</div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>
          </>
        )}
        {login?.oauthUrl && (
          <Dialog open onOpenChange={() => setLogin(null)}>
            <DialogContent>
              <DialogHeader><DialogTitle>Complete OAuth login</DialogTitle><DialogDescription>Open the authorization page and finish login.</DialogDescription></DialogHeader>
              <div className="space-y-2 text-sm">
                <div className="rounded-md border border-border/70 bg-muted/40 p-3 break-all">{login.oauthUrl}</div>
                <Button onClick={() => window.open(login.oauthUrl!, "_blank", "noopener,noreferrer")}>Open authorization page</Button>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </CardContent>
    </Card>
  )
}

// ── Custom API-key Providers (MiniMax etc. via CLIProxyAPI management) ─────

type ModelRow = { id: string; name: string; alias: string }
type CustomProviderDraft = {
  mode: "create" | "edit"
  kind: "openai" | "anthropic"
  name: string
  base_url: string
  api_key: string
  models: ModelRow[]
  originalId?: string
}

function newModelRow(): ModelRow {
  return { id: crypto.randomUUID(), name: "", alias: "" }
}

function emptyDraft(): CustomProviderDraft {
  return { mode: "create", kind: "openai", name: "", base_url: "", api_key: "", models: [newModelRow()] }
}

function CustomProvidersCard({ onRefreshCatalog }: { onRefreshCatalog: () => Promise<void> }) {
  const [items, setItems] = useState<CustomProvider[]>([])
  const [status, setStatus] = useState<{ available: boolean; reason?: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [draft, setDraft] = useState<CustomProviderDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const st = await api.customProviders.status()
      setStatus(st)
      if (st.available) {
        const list = await api.customProviders.list().catch(() => ({ providers: [] as CustomProvider[] }))
        setItems(list.providers ?? [])
        setError(null)
      } else {
        setItems([])
      }
    } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  const openCreate = () => { setError(null); setDraft(emptyDraft()) }
  const openEdit = (p: CustomProvider) => {
    setError(null)
    setDraft({
      mode: "edit",
      kind: p.kind,
      name: p.kind === "openai" ? p.name : "",
      base_url: p.base_url,
      api_key: "",
      models: p.models.length ? p.models.map(m => ({ id: crypto.randomUUID(), name: m.name, alias: m.alias ?? "" })) : [newModelRow()],
      originalId: p.id,
    })
  }

  const save = async () => {
    if (!draft) return
    setSaving(true); setError(null)
    try {
      const models = draft.models
        .map(m => ({ name: m.name.trim(), alias: m.alias.trim() || undefined }))
        .filter(m => m.name.length > 0)
      await api.customProviders.upsert({
        kind: draft.kind,
        name: draft.kind === "openai" ? draft.name.trim() : undefined,
        base_url: draft.base_url.trim(),
        api_key: draft.api_key.trim() || undefined,
        models,
      })
      setDraft(null)
      await load()
      await onRefreshCatalog()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setSaving(false) }
  }

  const remove = async (p: CustomProvider) => {
    if (!confirm(`Remove custom provider "${p.name}"? Its models will stop being available.`)) return
    setError(null)
    try {
      await api.customProviders.remove(p.kind, p.id)
      await load()
      await onRefreshCatalog()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const setModel = (id: string, patch: Partial<ModelRow>) =>
    setDraft(d => d ? { ...d, models: d.models.map(m => m.id === id ? { ...m, ...patch } : m) } : d)
  const addModel = () => setDraft(d => d ? { ...d, models: [...d.models, newModelRow()] } : d)
  const removeModel = (id: string) => setDraft(d => d ? { ...d, models: d.models.filter(m => m.id !== id) } : d)

  const identityLocked = draft?.mode === "edit"
  const canSave = !!draft
    && /^https?:\/\//i.test(draft.base_url.trim())
    && (draft.kind !== "openai" || /^[a-zA-Z0-9._-]+$/.test(draft.name.trim()))
    && (draft.mode === "edit" || draft.api_key.trim().length > 0)

  return (
    <Card className="border-border/70 bg-card/80">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Custom providers</CardTitle>
            <CardDescription>Add an OpenAI- or Anthropic-compatible endpoint by API key + base URL (e.g. MiniMax). Routed through CLIProxyAPI.</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              <RotateCcw className={cn("mr-2 size-4", loading && "animate-spin")} />Refresh
            </Button>
            <Button size="sm" onClick={openCreate} disabled={status ? !status.available : true}>
              <Plus className="mr-2 size-4" />Add provider
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {status && !status.available && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
            Management API unavailable — custom providers cannot be managed. {status.reason && <span className="text-muted-foreground">({status.reason})</span>}
            <div className="mt-1 text-xs text-muted-foreground">Set <code>remote-management.secret-key</code> in the CLIProxyAPI config and <code>MANAGEMENT_SECRET</code> in Dana to match.</div>
          </div>
        )}

        {status?.available && items.length === 0 && (
          <div className="rounded-md border border-dashed border-border/70 p-6 text-center text-sm text-muted-foreground">
            No custom providers yet. Click <span className="font-medium">Add provider</span> to connect one (e.g. MiniMax).
          </div>
        )}

        {items.length > 0 && (
          <div className="grid gap-3 md:grid-cols-2">
            {items.map(p => (
              <Card key={`${p.kind}:${p.id}`} className="border-border/70 bg-background/70">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-base truncate">{p.name}</CardTitle>
                    <Badge variant="secondary">{p.kind === "openai" ? "OpenAI-compatible" : "Anthropic-compatible"}</Badge>
                  </div>
                  <CardDescription className="truncate">{p.base_url}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <KeyRound className="size-3.5" /> {p.key_hint || "no key"}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {p.models.length === 0 && <span className="text-xs text-muted-foreground">all upstream models</span>}
                    {p.models.map((m, i) => (
                      <Badge key={`${i}-${m.alias || m.name}`} variant="outline" className="text-xs">{m.alias || m.name}</Badge>
                    ))}
                  </div>
                  <div className="flex gap-2 pt-1">
                    <Button variant="outline" size="sm" onClick={() => openEdit(p)}><Pencil className="mr-2 size-3.5" />Edit</Button>
                    <Button variant="outline" size="sm" onClick={() => void remove(p)}><Trash2 className="mr-2 size-3.5" />Remove</Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {error && !draft && <div className="text-sm text-destructive">{error}</div>}

        {draft && (
          <Dialog open onOpenChange={(o) => { if (!o) setDraft(null) }}>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>{draft.mode === "create" ? "Add custom provider" : "Edit custom provider"}</DialogTitle>
                <DialogDescription>Connects to CLIProxyAPI's {draft.kind === "openai" ? "openai-compatibility" : "claude-api-key"} upstream. Changes apply immediately (hot-reload).</DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div className="space-y-1">
                  <Label>Type</Label>
                  <Select value={draft.kind} onValueChange={(v) => setDraft(d => d ? { ...d, kind: v as "openai" | "anthropic" } : d)} disabled={identityLocked}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="openai">OpenAI-compatible (/v1)</SelectItem>
                      <SelectItem value="anthropic">Anthropic-compatible (/anthropic)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {draft.kind === "openai" && (
                  <div className="space-y-1">
                    <Label>Name</Label>
                    <Input value={draft.name} placeholder="minimax-openai" disabled={identityLocked}
                      onChange={(e) => setDraft(d => d ? { ...d, name: e.target.value } : d)} />
                    <p className="text-xs text-muted-foreground">Unique id (letters, digits, dot, dash, underscore). Locked when editing.</p>
                  </div>
                )}

                <div className="space-y-1">
                  <Label>Base URL</Label>
                  <Input value={draft.base_url} placeholder={draft.kind === "openai" ? "https://api.minimax.io/v1" : "https://api.minimax.io/anthropic"}
                    disabled={identityLocked && draft.kind === "anthropic"}
                    onChange={(e) => setDraft(d => d ? { ...d, base_url: e.target.value } : d)} />
                  {identityLocked && draft.kind === "anthropic" && <p className="text-xs text-muted-foreground">Base URL is the provider id — locked when editing.</p>}
                </div>

                <div className="space-y-1">
                  <Label>API key</Label>
                  <Input type="password" value={draft.api_key} placeholder={draft.mode === "edit" ? "•••• (leave blank to keep current)" : "sk-..."}
                    onChange={(e) => setDraft(d => d ? { ...d, api_key: e.target.value } : d)} />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Models</Label>
                    <Button variant="ghost" size="sm" onClick={addModel}><Plus className="mr-1 size-3.5" />Add model</Button>
                  </div>
                  {draft.models.map((m) => (
                    <div key={m.id} className="flex items-center gap-2">
                      <Input className="flex-1" value={m.name} placeholder="upstream name (MiniMax-M2.7)" onChange={(e) => setModel(m.id, { name: e.target.value })} />
                      <Input className="flex-1" value={m.alias} placeholder="alias (minimax-m2.7)" onChange={(e) => setModel(m.id, { alias: e.target.value })} />
                      <Button variant="ghost" size="icon" onClick={() => removeModel(m.id)}><Trash2 className="size-4" /></Button>
                    </div>
                  ))}
                  <p className="text-xs text-muted-foreground">Alias is the model name shown in Dana. Leave models empty to expose all upstream models.</p>
                </div>

                {error && <div className="text-sm text-destructive">{error}</div>}

                <div className="flex justify-end gap-2 pt-2">
                  <Button variant="outline" onClick={() => setDraft(null)} disabled={saving}>Cancel</Button>
                  <Button onClick={() => void save()} disabled={saving || !canSave}>{saving ? "Saving..." : "Save"}</Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </CardContent>
    </Card>
  )
}

// ── System Prompts Panel (the command center) ─────────────────────────────

type PromptItem = {
  name: string
  path: string
  content: string
  agent: string
  variables: string[]
  stage: string
  model: string | null
  tools: string[]
  task_profile: string | null
}

type ToolCatalogItem = { name: string; description: string; category: string }

const profileLabels: Record<string, string> = {
  fast: "Fast",
  balanced: "Balanced",
  deep_reasoning: "Deep Reasoning",
}

function smartDefaultLabel(profile: string | null, catalogModels: CatalogModel[]): string {
  if (!profile) return "No auto-selection"
  const available = catalogModels.filter(m => m.available)
  if (available.length === 0) return `Auto (${profileLabels[profile] ?? profile})`
  const tierOrder: Record<string, CatalogModel["tier"][]> = {
    fast: ["fast", "balanced", "powerful"],
    balanced: ["balanced", "fast", "powerful"],
    deep_reasoning: ["powerful", "balanced", "fast"],
  }
  const order = tierOrder[profile] ?? ["balanced"]
  for (const tier of order) {
    const match = available.find(m => m.tier === tier && m.type === "claude")
      ?? available.find(m => m.tier === tier && m.type === "openai")
      ?? available.find(m => m.tier === tier)
    if (match) return `Auto \u00b7 ${match.display_name}`
  }
  return `Auto (${profileLabels[profile] ?? profile})`
}

function PromptsPanel({ catalogModels }: { catalogModels: CatalogModel[] }) {
  const [prompts, setPrompts] = useState<PromptItem[]>([])
  const [expandedStages, setExpandedStages] = useState<Record<string, boolean>>({})
  const [selectedPrompt, setSelectedPrompt] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [toolCatalog, setToolCatalog] = useState<ToolCatalogItem[]>([])

  const loadPrompts = async () => {
    setLoading(true)
    try {
      const [data, catalog] = await Promise.all([
        api.prompts.list(),
        api.prompts.toolCatalog(),
      ])
      setPrompts(data)
      setToolCatalog(catalog)
      setExpandedStages(cur => {
        const next = { ...cur }
        for (const stage of Array.from(new Set(data.map(i => i.stage)))) { if (next[stage] === undefined) next[stage] = false }
        return next
      })
      setDrafts(cur => {
        const next = { ...cur }
        for (const p of data) { if (next[p.name] === undefined) next[p.name] = p.content }
        return next
      })
    } finally { setLoading(false) }
  }

  useEffect(() => { void loadPrompts() }, [])

  const stages = useMemo(() => {
    const grouped = new Map<string, PromptItem[]>()
    const q = searchQuery.toLowerCase().trim()
    for (const p of prompts) {
      if (q && !p.name.toLowerCase().includes(q) && !p.stage.toLowerCase().includes(q) && !p.agent.toLowerCase().includes(q)) continue
      if (!grouped.has(p.stage)) grouped.set(p.stage, [])
      grouped.get(p.stage)!.push(p)
    }
    return Array.from(grouped.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [prompts, searchQuery])

  const selected = prompts.find(p => p.name === selectedPrompt) ?? null
  const draft = selected ? drafts[selected.name] ?? selected.content : ""
  const dirty = !!selected && draft !== selected.content

  const toggleStage = (stage: string) => setExpandedStages(cur => ({ ...cur, [stage]: !cur[stage] }))

  const savePrompt = async () => {
    if (!selected) return
    setSaving(selected.name)
    try {
      const updated = await api.prompts.update(selected.name, draft)
      setPrompts(cur => cur.map(p => p.name === updated.name ? updated : p))
      setDrafts(cur => ({ ...cur, [updated.name]: updated.content }))
      setMessage("Saved"); setTimeout(() => setMessage(null), 2000)
    } finally { setSaving(null) }
  }

  const resetPrompt = async () => {
    if (!selected) return
    setSaving(`${selected.name}:reset`)
    try {
      const updated = await api.prompts.reset(selected.name)
      setPrompts(cur => cur.map(p => p.name === updated.name ? updated : p))
      setDrafts(cur => ({ ...cur, [updated.name]: updated.content }))
      setMessage("Restored"); setTimeout(() => setMessage(null), 2000)
    } finally { setSaving(null) }
  }

  const updateConfig = async (name: string, config: { model?: string | null; tools?: string[] }) => {
    setSaving(`${name}:config`)
    try {
      const result = await api.prompts.updateConfig(name, config)
      setPrompts(cur => cur.map(p => p.name === name ? { ...p, model: result.model, tools: result.tools } : p))
      setMessage("Config saved"); setTimeout(() => setMessage(null), 2000)
    } finally { setSaving(null) }
  }

  const toggleTool = (toolName: string) => {
    if (!selected) return
    const next = selected.tools.includes(toolName)
      ? selected.tools.filter(t => t !== toolName)
      : [...selected.tools, toolName]
    void updateConfig(selected.name, { tools: next })
  }

  const promptBaseName = (name: string) => { const parts = name.split("/"); return parts[parts.length - 1] ?? name }

  const stageIcon: Record<string, string> = {
    discovery: "🔍", enrichment: "📊", forum: "💬", scoring: "🎯",
    weight: "⚖️", representative: "🗣️", "clue-extractor": "🧩",
    "clue-processor": "⚙️", "party-intelligence": "🧠",
    "delta-representative": "🔄",
  }

  return (
    <div className="rounded-xl border border-border/70 bg-card/80 overflow-hidden">
      <div className="flex" style={{ height: "calc(100vh - 220px)", minHeight: "500px" }}>
        {/* Left panel */}
        <div className="flex w-64 shrink-0 flex-col border-r border-border/70 bg-background/50">
          <div className="border-b border-border/70 p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Filter prompts..." className="h-8 pl-8 text-xs" />
            </div>
          </div>
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-0.5">
              {loading && <div className="p-3 text-xs text-muted-foreground">Loading...</div>}
              {stages.map(([stage, items]) => (
                <div key={stage}>
                  <button type="button" onClick={() => toggleStage(stage)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/40 transition-colors">
                    {expandedStages[stage] ? <ChevronDown className="size-3 text-muted-foreground" /> : <ChevronRight className="size-3 text-muted-foreground" />}
                    <span className="text-xs">{stageIcon[stage] ?? "📄"}</span>
                    <span className="flex-1 text-xs font-medium capitalize">{stage.replace(/-/g, " ")}</span>
                    <span className="text-[10px] tabular-nums text-muted-foreground">{items.length}</span>
                  </button>
                  {expandedStages[stage] && items.map(prompt => {
                    const isSelected = selectedPrompt === prompt.name
                    const isDirty = drafts[prompt.name] !== undefined && drafts[prompt.name] !== prompt.content
                    const hasTools = prompt.tools.length > 0
                    const hasModel = !!prompt.model
                    return (
                      <button key={prompt.name} type="button" onClick={() => { setSelectedPrompt(prompt.name); setMessage(null) }}
                        className={cn("flex w-full items-center gap-2 rounded-md py-1.5 pl-7 pr-2 text-left transition-colors", isSelected ? "bg-primary/10 text-primary" : "hover:bg-accent/40")}>
                        <FileText className="size-3 shrink-0 text-muted-foreground" />
                        <span className="flex-1 truncate text-xs">{promptBaseName(prompt.name)}</span>
                        {hasTools && <Wrench className="size-3 shrink-0 text-muted-foreground" />}
                        {hasModel && <span className="size-1.5 shrink-0 rounded-full bg-blue-500" />}
                        {isDirty && <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />}
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
          </ScrollArea>
          <div className="border-t border-border/70 px-3 py-2">
            <div className="text-[10px] text-muted-foreground">{prompts.length} prompts</div>
          </div>
        </div>

        {/* Right panel */}
        {selected ? (
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Header */}
            <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-2.5">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="truncate text-sm font-medium">{selected.name}</h3>
                  {dirty && <Badge variant="secondary" className="text-[10px]">modified</Badge>}
                  {message && <Badge variant="outline" className="gap-1 text-[10px] text-green-600"><Check className="size-3" />{message}</Badge>}
                </div>
                <div className="text-xs text-muted-foreground">{selected.stage} / {selected.agent}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => void resetPrompt()} disabled={saving === `${selected.name}:reset`}>
                  <RotateCcw className="size-3.5" />{saving === `${selected.name}:reset` ? "Resetting..." : "Reset"}
                </Button>
                <Button type="button" size="sm" onClick={() => void savePrompt()} disabled={!dirty || saving === selected.name}>
                  {saving === selected.name ? "Saving..." : "Save"}
                </Button>
              </div>
            </div>

            {/* Model + Tools config */}
            <div className="space-y-3 border-b border-border/70 px-4 py-3">
              <div className="flex items-center gap-3">
                <Label className="shrink-0 text-xs text-muted-foreground w-12">Model</Label>
                <Select
                  value={selected.model ?? "__auto__"}
                  onValueChange={v => void updateConfig(selected.name, { model: v === "__auto__" ? null : v })}
                >
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__auto__">
                      <span className="flex items-center gap-1.5">
                        <Zap className="size-3 text-amber-500" />
                        {smartDefaultLabel(selected.task_profile, catalogModels)}
                      </span>
                    </SelectItem>
                    {(() => {
                      const available = catalogModels.filter(m => m.available)
                      const groups = new Map<string, CatalogModel[]>()
                      for (const m of available) {
                        const key = m.type || "other"
                        if (!groups.has(key)) groups.set(key, [])
                        groups.get(key)!.push(m)
                      }
                      const provLabel: Record<string, string> = { claude: "Anthropic", openai: "OpenAI", gemini: "Gemini" }
                      const order = ["claude", "openai", "gemini"]
                      const sorted = Array.from(groups.entries()).sort((a, b) => {
                        const ai = order.indexOf(a[0]), bi = order.indexOf(b[0])
                        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
                      })
                      return sorted.map(([type, models]) => (
                        <div key={type}>
                          <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{provLabel[type] ?? type}</div>
                          {models.map(m => (
                            <SelectItem key={m.id} value={m.id}>
                              <span className="flex items-center gap-2">
                                <span>{m.display_name}</span>
                                <span className={cn("text-[10px] rounded-full border px-1.5 py-0", tierConfig[m.tier].color)}>{tierConfig[m.tier].label}</span>
                                {m.context_length > 0 && <span className="text-[10px] text-muted-foreground">{formatTokens(m.context_length)}</span>}
                                {m.thinking && <Brain className="size-2.5 text-muted-foreground" />}
                              </span>
                            </SelectItem>
                          ))}
                        </div>
                      ))
                    })()}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-3">
                <Label className="shrink-0 text-xs text-muted-foreground w-12">Tools</Label>
                <div className="flex flex-wrap gap-1.5">
                  {toolCatalog.map(tool => {
                    const active = selected.tools.includes(tool.name)
                    return (
                      <button key={tool.name} type="button" onClick={() => toggleTool(tool.name)} title={tool.description}
                        className={cn("rounded-full border px-2.5 py-0.5 text-xs transition-colors", active ? "border-primary bg-primary/10 text-primary" : "border-border/70 text-muted-foreground hover:bg-accent/40")}>
                        {tool.name}
                      </button>
                    )
                  })}
                  {toolCatalog.length === 0 && <span className="text-xs text-muted-foreground">No tools available</span>}
                </div>
              </div>
            </div>

            {/* Variable chips */}
            {selected.variables.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 border-b border-border/70 px-4 py-2">
                <span className="text-[10px] text-muted-foreground">Variables:</span>
                {selected.variables.map(v => <Badge key={v} variant="secondary" className="cursor-default text-[10px] font-mono">{`{${v}}`}</Badge>)}
              </div>
            )}

            {/* Textarea */}
            <div className="relative min-h-0 flex-1 p-4">
              <Textarea value={draft} onChange={e => setDrafts(cur => ({ ...cur, [selected.name]: e.target.value }))}
                className="h-full resize-none overflow-auto border-0 bg-transparent p-0 font-mono text-sm shadow-none [field-sizing:fixed] focus-visible:ring-0" placeholder="Enter prompt content..." />
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between border-t border-border/70 px-4 py-2">
              <div className="text-[10px] tabular-nums text-muted-foreground">{draft.length} chars</div>
              <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                {selected.tools.length > 0 && <span>{selected.tools.length} tool{selected.tools.length === 1 ? "" : "s"}</span>}
                {selected.model && <span className="font-mono">{selected.model}</span>}
                <span>{selected.variables.length} var{selected.variables.length === 1 ? "" : "s"}</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-center">
              <FileText className="mx-auto size-10 text-muted-foreground/30" />
              <p className="mt-3 text-sm text-muted-foreground">Select a prompt to configure</p>
              <p className="mt-1 text-xs text-muted-foreground/70">Set model, tools, and edit prompt content</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Analysis Controls Panel (two-panel layout) ────────────────────────────

type ControlField = { key: keyof typeof CONTROLS_DEFAULTS; label: string; hint: string; min: number; max: number; step?: number }

type ControlCategory = { id: string; label: string; icon: string; description: string; fields: ControlField[] }

const CATEGORIES: ControlCategory[] = [
  {
    id: "discovery", label: "Discovery", icon: "🔍",
    description: "Controls for initial topic research and party scoring.",
    fields: [
      { key: "discovery_research_iterations", label: "Research depth", hint: "Max agentic loop rounds for initial topic research", min: 2, max: 30 },
      { key: "discovery_context_warning", label: "Context budget warning", hint: "Token count at which the LLM is told to wrap up", min: 50000, max: 200000, step: 10000 },
      { key: "scoring_iterations", label: "Scoring depth", hint: "Max rounds per party for evidence-based power scoring", min: 2, max: 20 },
      { key: "scoring_context_warning", label: "Scoring context budget", hint: "Token limit for each party scoring session", min: 50000, max: 200000, step: 10000 },
      { key: "scoring_batch_size", label: "Scoring parallelism", hint: "Number of parties scored in parallel", min: 1, max: 8 },
      { key: "scoring_ensemble_runs", label: "Scenario scorer ensemble runs", hint: "Independent scorer passes for the final probabilities; >1 reports mean ± spread (uncertainty bands). Higher = more cost.", min: 1, max: 5 },
    ],
  },
  {
    id: "enrichment", label: "Enrichment", icon: "📊",
    description: "Controls for per-party research, clue storage, and fact-checking. Only web_search counts as a research round — fetch and store_clue are free.",
    fields: [
      { key: "enrichment_iterations", label: "Research rounds", hint: "Research rounds per party. Only web_search counts — fetch_url and store_clue are free.", min: 2, max: 25 },
      { key: "enrichment_max_searches_per_round", label: "Searches per round", hint: "Max web_search calls allowed per research round", min: 1, max: 5 },
      { key: "enrichment_max_fetches_per_round", label: "Fetches per round", hint: "Max fetch_url calls per research round (match or exceed search results)", min: 2, max: 10 },
      { key: "enrichment_context_warning", label: "Context budget", hint: "Token count at which agent is told to wrap up", min: 50000, max: 200000, step: 10000 },
      { key: "enrichment_batch_size", label: "Parallelism", hint: "Number of parties enriched in parallel", min: 1, max: 8 },
      { key: "fact_check_iterations", label: "Fact-check depth", hint: "Max rounds for adversarial fact-check per clue", min: 1, max: 8 },
      { key: "smart_extract_url_limit", label: "URL fetch limit", hint: "Max URLs fetched during smart clue extraction", min: 3, max: 30 },
      { key: "research_search_queries", label: "Research search queries", hint: "Max search queries in research-and-extract mode", min: 2, max: 20 },
      { key: "bulk_import_iterations", label: "Bulk import agent depth", hint: "Agentic rounds per chunk (web search + fact-check)", min: 2, max: 15 },
      { key: "bulk_import_chunk_target_chars", label: "Chunk target size", hint: "Target chars per chunk (~2000 = ~500 tokens); chunks accumulate until this size", min: 500, max: 8000, step: 500 },
      { key: "bulk_import_chunk_max_chars", label: "Chunk max size", hint: "Hard max chars per chunk before forcing a split", min: 1000, max: 16000, step: 1000 },
      { key: "bulk_fact_check_iterations", label: "Bulk fact-check depth", hint: "Agentic rounds for fact-checking each bulk import clue", min: 1, max: 5 },
      { key: "evidence_update_batch_size", label: "Evidence update parallelism", hint: "Clues checked for updates in parallel", min: 1, max: 8 },
      { key: "evidence_update_iterations", label: "Evidence update depth", hint: "Agentic rounds per clue when checking for updates", min: 1, max: 10 },
      { key: "cleanup_fact_check_iterations", label: "Cleanup fact-check depth", hint: "Agentic rounds for fact-checking merged clues after cleanup", min: 1, max: 5 },
    ],
  },
  {
    id: "smart_edit", label: "Smart Edit", icon: "✏️",
    description: "Controls for user-triggered smart add, edit, split, and merge operations on clues and parties.",
    fields: [
      { key: "smart_edit_queries", label: "Search queries", hint: "Max web search queries per smart add/edit/split/merge", min: 1, max: 6 },
      { key: "smart_edit_max_chars", label: "Research text limit", hint: "Max characters of research material sent to LLM", min: 5000, max: 50000, step: 1000 },
    ],
  },
  {
    id: "forum", label: "Forum", icon: "💬",
    description: "Controls for the moderated multi-party debate.",
    fields: [
      { key: "forum_max_turns", label: "Max debate turns", hint: "Hard ceiling on total debate turns before forcing closure", min: 20, max: 200 },
      { key: "forum_min_turns_multiplier", label: "Min turns multiplier", hint: "Minimum turns = parties × this value (e.g., 10 parties × 2.5 = 25 min)", min: 1.5, max: 5, step: 0.5 },
      { key: "forum_scenario_update_interval", label: "Scenario update interval", hint: "Full scenario list update every N turns", min: 3, max: 20 },
      { key: "forum_compress_interval", label: "History compression", hint: "Compress conversation history every N turns to save context", min: 5, max: 50 },
      { key: "forum_speaking_budget", label: "Speaking budget", hint: "Word budget for representative statements", min: 200, max: 1200, step: 50 },
    ],
  },
  {
    id: "agentic", label: "Agentic Defaults", icon: "🤖",
    description: "Global defaults for all agentic loops, content fetching, and corpus caching.",
    fields: [
      { key: "max_fetch_chars", label: "Fetch content limit", hint: "Characters of each fetched page sent to LLM per tool call", min: 10000, max: 80000, step: 1000 },
      { key: "corpus_cache_hours", label: "Corpus cache window", hint: "Hours before similar search results are re-fetched from the web", min: 24, max: 72 },
    ],
  },
]

function PipelinePanel() {
  const [controls, setControls] = useState(CONTROLS_DEFAULTS)
  const [saved, setSaved] = useState(CONTROLS_DEFAULTS)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [activeCategory, setActiveCategory] = useState(CATEGORIES[0].id)

  useEffect(() => {
    void (async () => {
      const appSettings = await api.settings.get()
      const merged = { ...CONTROLS_DEFAULTS, ...(appSettings.analysis_controls ?? {}) }
      // Clamp any out-of-range values from older sessions
      for (const f of CATEGORIES.flatMap(c => c.fields)) {
        const v = Number(merged[f.key])
        if (!Number.isFinite(v) || v < f.min || v > f.max) {
          merged[f.key] = Math.max(f.min, Math.min(f.max, Number.isFinite(v) ? v : CONTROLS_DEFAULTS[f.key]))
        }
      }
      setControls(merged)
      setSaved(merged)
    })()
  }, [])

  const allFields = CATEGORIES.flatMap(c => c.fields)

  const validate = (next = controls) => {
    const nextErrors: Record<string, string> = {}
    for (const f of allFields) {
      const v = Number(next[f.key])
      if (!Number.isFinite(v) || v < f.min || v > f.max) nextErrors[f.key] = `${f.min}–${f.max}`
    }
    setErrors(nextErrors)
    return Object.keys(nextErrors).length === 0
  }

  const save = async () => {
    if (!validate()) return
    setSaving(true)
    try {
      const updated = await api.settings.update({ analysis_controls: controls })
      const next = { ...CONTROLS_DEFAULTS, ...(updated.analysis_controls ?? controls) }
      setControls(next); setSaved(next); setManualDirty(false); setMessage("Saved.")
      setTimeout(() => setMessage(null), 2000)
    } finally { setSaving(false) }
  }

  const reset = () => { setControls(CONTROLS_DEFAULTS); setErrors({}); setManualDirty(true); setMessage("Reset to defaults.") }

  const [manualDirty, setManualDirty] = useState(false)

  const update = (key: keyof typeof CONTROLS_DEFAULTS, value: string) => {
    const parsed = value === "" ? 0 : Number(value)
    const next = { ...controls, [key]: parsed }
    setControls(next); validate(next); setManualDirty(true)
  }

  const isDirty = manualDirty || JSON.stringify(controls) !== JSON.stringify(saved)
  const category = CATEGORIES.find(c => c.id === activeCategory) ?? CATEGORIES[0]

  const categoryDirtyCount = (cat: ControlCategory) =>
    cat.fields.filter(f => controls[f.key] !== saved[f.key]).length

  return (
    <div className="rounded-xl border border-border/70 bg-card/80 overflow-hidden">
      <div className="flex" style={{ height: "calc(100vh - 220px)", minHeight: "500px" }}>
        {/* Left sidebar */}
        <div className="flex w-56 shrink-0 flex-col border-r border-border/70 bg-background/50">
          <div className="border-b border-border/70 px-3 py-2.5">
            <div className="text-xs font-medium text-muted-foreground">Analysis Controls</div>
          </div>
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-0.5">
              {CATEGORIES.map(cat => {
                const isActive = activeCategory === cat.id
                const dirtyN = categoryDirtyCount(cat)
                return (
                  <button key={cat.id} type="button" onClick={() => setActiveCategory(cat.id)}
                    className={cn("flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
                      isActive ? "bg-primary/10 text-primary" : "hover:bg-accent/40")}>
                    <span className="text-sm">{cat.icon}</span>
                    <span className="flex-1 text-xs font-medium">{cat.label}</span>
                    <span className="text-[10px] tabular-nums text-muted-foreground">{cat.fields.length}</span>
                    {dirtyN > 0 && <span className="size-1.5 rounded-full bg-amber-500" />}
                  </button>
                )
              })}
            </div>
          </ScrollArea>
          <div className="border-t border-border/70 px-3 py-2">
            <div className="text-[10px] text-muted-foreground">{allFields.length} controls across {CATEGORIES.length} categories</div>
          </div>
        </div>

        {/* Right panel */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Header */}
          <div className="flex items-center justify-between gap-3 border-b border-border/70 px-5 py-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-base">{category.icon}</span>
                <h3 className="text-sm font-medium">{category.label}</h3>
                {message && <Badge variant="outline" className="gap-1 text-[10px] text-green-600"><Check className="size-3" />{message}</Badge>}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">{category.description}</div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button type="button" size="sm" variant="outline" onClick={reset}><RotateCcw className="size-3.5" />Reset all</Button>
              <Button type="button" size="sm" onClick={() => void save()} disabled={!isDirty || saving}>{saving ? "Saving..." : "Save"}</Button>
            </div>
          </div>

          {/* Fields */}
          <ScrollArea className="flex-1">
            <div className="divide-y divide-border/50">
              {category.fields.map(f => {
                const isModified = controls[f.key] !== CONTROLS_DEFAULTS[f.key]
                const hasError = !!errors[f.key]
                return (
                  <div key={f.key} className="flex items-center gap-4 px-5 py-3.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{f.label}</span>
                        {isModified && <span className="size-1.5 rounded-full bg-amber-500" title="Modified from default" />}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">{f.hint}</div>
                      {hasError && <div className="mt-0.5 text-xs text-destructive">Must be between {errors[f.key]}</div>}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Input
                        type="number"
                        min={f.min}
                        max={f.max}
                        step={f.step ?? 1}
                        value={String(controls[f.key])}
                        onChange={e => update(f.key, e.target.value)}
                        className={cn("w-28 text-right tabular-nums", hasError && "border-destructive")}
                      />
                      <div className="w-16 text-[10px] text-muted-foreground tabular-nums">{f.min}–{f.max}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          </ScrollArea>

          {/* Footer */}
          <div className="flex items-center justify-between border-t border-border/70 px-5 py-2">
            <div className="text-[10px] text-muted-foreground">
              {category.fields.length} controls in {category.label}
            </div>
            <div className="text-[10px] text-muted-foreground">
              {isDirty ? "Unsaved changes" : "All saved"}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}



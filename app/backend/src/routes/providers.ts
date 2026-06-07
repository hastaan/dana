// LLM provider management. Provider list / OAuth connect / disconnect all go through
// the CLIProxyAPI management API over HTTP (auth-files + *-auth-url + get-auth-status),
// so Dana never has to share the proxy's filesystem or spawn its binary. This works
// identically whether the proxy is bundled in this container or runs separately, and
// reflects the proxy's REAL live credential state (no stale/empty-dir mismatches).
//
// A read-only legacy fallback (scanning $CLIPROXY_AUTH_DIR / $DATA_DIR/.cli-proxy-api)
// is kept only for listing when the management API is unavailable.
import { Elysia, t } from "elysia"
import { readdirSync, existsSync, readFileSync } from "fs"
import { join } from "path"
import { fetchAvailableModels, isProxyAvailable, invalidateVerifiedModels } from "../llm/proxyClient"
import {
  listAuthFiles,
  deleteAuthFile,
  getProviderAuthUrl,
  getAuthStatus,
  getManagementStatus,
  ManagementError,
  ManagementUnavailableError,
} from "../llm/proxyAdmin"
import { log } from "../utils/logger"

// Dana-facing provider id → the proxy's OAuth auth-url endpoint.
const AUTH_URL_ENDPOINT: Record<string, string> = {
  claude: "anthropic-auth-url",
  openai: "codex-auth-url",
  gemini: "gemini-cli-auth-url",
}

function providerLabel(provider: string) {
  return provider === "claude" ? "Anthropic" : provider[0].toUpperCase() + provider.slice(1)
}

function normalizeProvider(provider: string) {
  return provider.toLowerCase().trim()
}

// Map the proxy's auth-file provider names to Dana's provider ids.
function danaProvider(p: string): string {
  const v = (p || "").toLowerCase()
  if (v === "codex") return "openai"
  if (v === "google") return "gemini"
  return v
}

function errorResponse(set: { status?: number | string }, e: unknown) {
  if (e instanceof ManagementUnavailableError) {
    set.status = 503
    return { error: "management_unavailable", message: e.message }
  }
  if (e instanceof ManagementError) {
    set.status = e.status === 401 ? 401 : 502
    return { error: "management_error", message: e.message }
  }
  set.status = 500
  return { error: "error", message: e instanceof Error ? e.message : String(e) }
}

// ── Legacy read-only fallback (only used if the management API is unavailable) ──
function legacyCredentialsDir() {
  return process.env.CLIPROXY_AUTH_DIR?.trim() || join(process.env.DATA_DIR || "/home/nima/dana/data", ".cli-proxy-api")
}
function legacyProviderFromFile(name: string) {
  const base = name.replace(/\.(json|yaml|yml|token)$/i, "").replace(/^(credentials-|auth-|token-)/, "")
  if (base.startsWith("claude-")) return "claude"
  if (base.startsWith("codex-") || base.startsWith("openai-") || base.startsWith("gpt-")) return "openai"
  if (base.startsWith("gemini-") || base.startsWith("google-")) return "gemini"
  return base.split("-")[0]
}
function legacyList() {
  const dir = legacyCredentialsDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .map((file) => {
      const provider = legacyProviderFromFile(file)
      let account: string | null = null
      try {
        const parsed = JSON.parse(readFileSync(join(dir, file), "utf8"))
        account = parsed?.email || parsed?.account || parsed?.username || parsed?.name || null
      } catch { /* ignore */ }
      return { provider, label: providerLabel(provider), status: "connected", account, credential_file: file }
    })
}

export const providersRouter = new Elysia({ prefix: "/api/providers" })
  .get("/", async () => {
    try {
      const files = await listAuthFiles()
      return {
        providers: files.map((f) => {
          const provider = danaProvider(f.provider)
          return {
            provider,
            label: providerLabel(provider),
            status: "connected",
            account: f.account || f.email || null,
            credential_file: f.id || f.name,
            health: f.status ?? null,             // ok | error (auth currently working?)
            health_message: f.status_message ?? null,
          }
        }),
      }
    } catch {
      // Management API unavailable — fall back to a read-only directory scan.
      return { providers: legacyList() }
    }
  })

  // Begin an OAuth login: the proxy returns a browser URL + a state to poll.
  .post("/login", async ({ body, set }) => {
    const provider = normalizeProvider(body.provider)
    const endpoint = AUTH_URL_ENDPOINT[provider]
    if (!endpoint) {
      set.status = 400
      return { error: "bad_request", message: `Unsupported provider "${provider}"` }
    }
    try {
      const { url, state } = await getProviderAuthUrl(endpoint)
      return { provider, oauth_url: url, state, status: "started" }
    } catch (e) {
      return errorResponse(set, e)
    }
  }, { body: t.Object({ provider: t.String() }) })

  // Poll an in-progress OAuth login by its state token.
  .get("/login/status", async ({ query }) => {
    const provider = normalizeProvider(String(query.provider ?? ""))
    const state = query.state ? String(query.state) : ""
    if (!state) return { provider, connected: false, timeout: false }
    try {
      const { status } = await getAuthStatus(state)
      if (status === "ok") {
        invalidateVerifiedModels()
        return { provider, connected: true, timeout: false }
      }
      if (status === "error") {
        return { provider, connected: false, timeout: false, error: "Authorization failed" }
      }
      return { provider, connected: false, timeout: false } // "wait"
    } catch {
      return { provider, connected: false, timeout: false }
    }
  })

  // Disconnect: remove every auth file the proxy holds for this provider.
  .delete("/:provider", async ({ params, set }) => {
    const provider = normalizeProvider(params.provider)
    try {
      const files = await listAuthFiles()
      const toDelete = files.filter((f) => danaProvider(f.provider) === provider)
      for (const f of toDelete) await deleteAuthFile(f.id || f.name)
      invalidateVerifiedModels()
      log.llm("Provider disconnected", `${provider} (${toDelete.length} credential(s))`)
      return { provider, removed: toDelete.length }
    } catch (e) {
      return errorResponse(set, e)
    }
  })

  .get("/models", async () => {
    const models = await fetchAvailableModels()
    const grouped = new Map<string, string[]>()
    for (const model of models) {
      const rawProvider = (model.owned_by || model.id.split("/")[0] || "unknown").toLowerCase()
      const provider = rawProvider === "anthropic" ? "claude" : rawProvider === "google" ? "gemini" : rawProvider
      if (!grouped.has(provider)) grouped.set(provider, [])
      grouped.get(provider)!.push(model.id)
    }
    return { providers: Array.from(grouped.entries()).map(([provider, models]) => ({ provider, models })) }
  })

  .get("/health", async () => {
    const proxyUp = await isProxyAvailable()
    let connectedProviders: string[] = []
    let credentialFiles = 0
    try {
      const files = await listAuthFiles()
      credentialFiles = files.length
      connectedProviders = [...new Set(files.map((f) => danaProvider(f.provider)))]
    } catch {
      const legacy = legacyList()
      credentialFiles = legacy.length
      connectedProviders = [...new Set(legacy.map((f) => f.provider))]
    }
    let modelCount = 0
    if (proxyUp) modelCount = (await fetchAvailableModels()).length
    return { proxy_online: proxyUp, connected_providers: connectedProviders, model_count: modelCount, credential_files: credentialFiles }
  })

  .get("/management-status", async () => getManagementStatus())

import { Elysia, t } from "elysia"
import { readdirSync, rmSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { spawn } from "child_process"
import { fetchAvailableModels, isProxyAvailable, invalidateVerifiedModels } from "../llm/proxyClient"

const credentialsDir = () => join(process.env.DATA_DIR || "/home/nima/dana/data", ".cli-proxy-api")
const loginTimeoutMs = Number(process.env.PROVIDER_LOGIN_TIMEOUT_MS || 120000)
const activeLogins = new Map<string, { startedAt: number; oauthUrl?: string; done: boolean; error?: string; proc?: ReturnType<typeof spawn> }>()

function ensureCredentialsDir() {
  mkdirSync(credentialsDir(), { recursive: true })
}

function providerLabel(provider: string) {
  return provider === "claude" ? "Anthropic" : provider[0].toUpperCase() + provider.slice(1)
}

function scanProviderCredentials() {
  const dir = credentialsDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => name.endsWith(".json") || name.endsWith(".yaml") || name.endsWith(".yml") || name.endsWith(".token"))
}

function normalizeProvider(provider: string) {
  return provider.toLowerCase().trim()
}

function loginFlagForProvider(provider: string) {
  if (provider === "openai") return "codex"
  if (provider === "gemini") return "login"
  return provider
}

function providerFromFile(name: string) {
  const normalized = name.replace(/\.(json|yaml|yml|token)$/i, "")
  const base = normalized.replace(/^(credentials-|auth-|token-)/, "")
  if (base.startsWith("claude-")) return "claude"
  if (base.startsWith("codex-") || base.startsWith("openai-") || base.startsWith("gpt-")) return "openai"
  if (base.startsWith("gemini-") || base.startsWith("google-") || base === "google") return "gemini"
  if (base.startsWith("qwen-")) return "qwen"
  if (base.startsWith("kimi-")) return "kimi"
  if (base.startsWith("iflow-")) return "iflow"
  if (base.startsWith("antigravity-")) return "antigravity"
  return base.split("-")[0]
}

export const providersRouter = new Elysia({ prefix: "/api/providers" })
  .get("/", async () => {
    const files = scanProviderCredentials()
    const connected = files.map(file => {
      const provider = providerFromFile(file)
      let account: string | null = null
      try {
        const raw = readFileSync(join(credentialsDir(), file), "utf8")
        const parsed = raw.trim().startsWith("{") ? JSON.parse(raw) : null
        account = parsed?.email || parsed?.account || parsed?.username || parsed?.name || null
      } catch {}
      return { provider, label: providerLabel(provider), status: "connected", account, credential_file: file }
    })
    return { providers: connected }
  })
  .post("/login", async ({ body, set }) => {
    if (!(await isProxyAvailable())) {
      set.status = 503
      return { error: "CLIProxyAPI unavailable" }
    }

    const provider = normalizeProvider(body.provider)
    ensureCredentialsDir()

    // Kill any previous login process for this provider
    const existing = activeLogins.get(provider)
    if (existing?.proc) {
      try { existing.proc.kill() } catch {}
    }

    const callbackPort = process.env.OAUTH_CALLBACK_PORT || "54545"
    const loginFlag = loginFlagForProvider(provider)
    // Gemini's -login flag starts a full proxy — use a separate config on a non-conflicting port
    const needsSeparateConfig = loginFlag === "login"
    let configFlag: string
    if (needsSeparateConfig) {
      const loginConfigPath = "/tmp/cli-proxy-login-config.yaml"
      writeFileSync(loginConfigPath, `port: 29999\nauth-dir: "${credentialsDir()}"\n`)
      configFlag = `-config ${loginConfigPath}`
    } else {
      configFlag = process.env.CLIPROXY_CONFIG ? `-config ${process.env.CLIPROXY_CONFIG}` : "-config /tmp/cli-proxy-config.yaml"
    }
    const callbackArg = loginFlag === "codex" ? "" : `-oauth-callback-port ${callbackPort} `
    const loginArg = loginFlag === "login" ? "-login" : `-${loginFlag}-login`
    const command = `CLIProxyAPI ${configFlag} ${callbackArg}${loginArg} -no-browser`
    const proc = spawn(command, { shell: true, env: process.env })
    const state = { startedAt: Date.now(), done: false, oauthUrl: undefined as string | undefined, error: undefined as string | undefined, proc }
    activeLogins.set(provider, state)

    // Gemini login requires interactive project selection — auto-select Google One mode
    if (needsSeparateConfig && proc.stdin) {
      const autoRespond = (text: string) => {
        if (/Enter choice \[1\/2\]/i.test(text)) proc.stdin?.write("1\n")
        else if (/Enter choice \[1\]/i.test(text)) proc.stdin?.write("1\n")
        else if (/Enter project/i.test(text)) proc.stdin?.write("\n")
      }
      proc.stdout.on("data", (chunk: Buffer) => autoRespond(String(chunk)))
    }

    const logLines: string[] = []
    proc.stdout.on("data", chunk => {
      const text = String(chunk)
      logLines.push(`[stdout] ${text.trim()}`)
      const match = text.match(/https?:\/\/\S+/)
      if (match && !state.oauthUrl) state.oauthUrl = match[0]
    })
    proc.stderr.on("data", chunk => {
      const text = String(chunk)
      logLines.push(`[stderr] ${text.trim()}`)
      if (!state.error) state.error = text.trim()
    })
    proc.on("exit", code => {
      state.done = code === 0
      logLines.push(`[exit] code=${code}`)
      try { writeFileSync("/tmp/provider-login-debug.log", logLines.join("\n") + "\n") } catch {}
      if (code === 0) invalidateVerifiedModels()
    })

    return { provider, oauth_url: state.oauthUrl ?? null, status: "started" }
  }, { body: t.Object({ provider: t.String() }) })
  .get("/login/status", async ({ query }) => {
    const provider = normalizeProvider(query.provider)
    const state = activeLogins.get(provider)
    const credential = scanProviderCredentials().find(file => providerFromFile(file) === provider)
    if (credential) {
      return { provider, connected: true, timeout: false }
    }
    if (!state) return { provider, connected: false, timeout: false }
    const timedOut = Date.now() - state.startedAt > loginTimeoutMs
    if (timedOut) return { provider, connected: false, timeout: true }
    return { provider, connected: state.done, timeout: false, oauth_url: state.oauthUrl ?? null, error: state.error ?? null }
  })
  .delete("/:provider", async ({ params, set }) => {
    const provider = normalizeProvider(params.provider)
    ensureCredentialsDir()
    const files = scanProviderCredentials().filter(file => providerFromFile(file) === provider)
    for (const file of files) rmSync(join(credentialsDir(), file), { force: true })
    invalidateVerifiedModels()
    return { provider, removed: files.length }
  })
  .get("/models", async () => {
    const models = await fetchAvailableModels()
    const grouped = new Map<string, string[]>()
    for (const model of models) {
      const rawProvider = (model.owned_by || model.id.split("/")[0] || "unknown").toLowerCase()
      const provider = rawProvider === "anthropic" ? "claude"
        : rawProvider === "google" ? "gemini"
        : rawProvider
      if (!grouped.has(provider)) grouped.set(provider, [])
      grouped.get(provider)!.push(model.id)
    }
    return { providers: Array.from(grouped.entries()).map(([provider, models]) => ({ provider, models })) }
  })
  .get("/health", async () => {
    const proxyUp = await isProxyAvailable()
    const credentials = scanProviderCredentials()
    const connectedProviders = [...new Set(credentials.map(f => providerFromFile(f)))]
    let modelCount = 0
    if (proxyUp) {
      const models = await fetchAvailableModels()
      modelCount = models.length
    }
    return {
      proxy_online: proxyUp,
      connected_providers: connectedProviders,
      model_count: modelCount,
      credential_files: credentials.length,
    }
  })

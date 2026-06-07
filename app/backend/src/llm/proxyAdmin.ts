// Typed client for the CLIProxyAPI Management API (/v0/management).
// Lets Dana add/edit/remove custom upstream providers (OpenAI-compatible and
// Anthropic-compatible) by API key + base URL — e.g. MiniMax — at runtime.
// CLIProxyAPI persists changes to its config.yaml and hot-reloads (no restart).
//
// Verified contract (against eceasy/cli-proxy-api:latest):
//   Base:  $PROXY_BASE_URL/v0/management
//   Auth:  Authorization: Bearer <secret-key>   (missing → 401 "missing management key")
//   GET    /openai-compatibility → { "openai-compatibility": [...] | null }
//   PUT    /openai-compatibility → body is the raw array (replaces whole list) → { status: "ok" }
//   DELETE /openai-compatibility?name=x → { status: "ok" }
//   GET/PUT /claude-api-key  (symmetric; we use read-modify-write PUT for all mutations)
import { log } from "../utils/logger"

const PROXY_BASE_URL = process.env.PROXY_BASE_URL || "http://127.0.0.1:8317"
const MGMT_BASE = `${PROXY_BASE_URL.replace(/\/+$/, "")}/v0/management`
const TIMEOUT_MS = 15_000

function secret(): string {
  return process.env.MANAGEMENT_SECRET || ""
}

// ── Wire types (CLIProxyAPI config shape — kebab-case keys) ──────────────────

export interface ProviderModel {
  name: string
  alias?: string
}

export interface OpenAIKeyEntry {
  "api-key": string
  "proxy-url"?: string
}

export interface OpenAICompatProvider {
  name: string
  "base-url": string
  "api-key-entries": OpenAIKeyEntry[]
  models: ProviderModel[]
  headers?: Record<string, string>
  prefix?: string
  disabled?: boolean
}

export interface ClaudeKeyProvider {
  "api-key": string
  "base-url": string
  "proxy-url"?: string
  models: ProviderModel[]
}

export class ManagementError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = "ManagementError"
  }
}

export class ManagementUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ManagementUnavailableError"
  }
}

// ── Low-level fetch ──────────────────────────────────────────────────────────

async function mgmtFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const sk = secret()
  if (!sk) {
    throw new ManagementUnavailableError(
      "MANAGEMENT_SECRET is not set — cannot reach the CLIProxyAPI management API. " +
        "Add remote-management.secret-key to the proxy config and set MANAGEMENT_SECRET to match.",
    )
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetch(`${MGMT_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${sk}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    })
  } catch (e) {
    throw new ManagementUnavailableError(
      `CLIProxyAPI management API unreachable at ${MGMT_BASE}: ${e instanceof Error ? e.message : String(e)}`,
    )
  } finally {
    clearTimeout(timer)
  }
}

// NOTE: never include the raw proxy response body in an error that reaches the
// client — the PUT body (and possibly echoed errors) contains plaintext API keys.
// Log the full body server-side; throw a generic, key-free message.
async function mgmtGet<T>(path: string, key: string): Promise<T[]> {
  const res = await mgmtFetch(path, { method: "GET" })
  if (res.status === 401) throw new ManagementError("Management key rejected by proxy (401)", 401)
  if (res.status === 404) throw new ManagementUnavailableError(`Endpoint ${path} not found (404) — management may be disabled or unsupported by this proxy version`)
  if (!res.ok) {
    log.error("proxyAdmin", `GET ${path} → HTTP ${res.status}: ${await res.text().catch(() => "")}`)
    throw new ManagementError(`Proxy management GET ${path} failed (HTTP ${res.status})`, res.status)
  }
  let data: Record<string, unknown>
  try {
    data = (await res.json()) as Record<string, unknown>
  } catch (e) {
    log.error("proxyAdmin", `GET ${path} returned non-JSON`, e)
    throw new ManagementError(`Proxy management GET ${path} returned an unparseable response`, 502)
  }
  const list = data[key]
  return Array.isArray(list) ? (list as T[]) : []
}

async function mgmtPut(path: string, body: unknown): Promise<void> {
  const res = await mgmtFetch(path, { method: "PUT", body: JSON.stringify(body) })
  if (res.status === 401) throw new ManagementError("Management key rejected by proxy (401)", 401)
  if (!res.ok) {
    log.error("proxyAdmin", `PUT ${path} → HTTP ${res.status}: ${await res.text().catch(() => "")}`)
    throw new ManagementError(`Proxy management PUT ${path} failed (HTTP ${res.status})`, res.status)
  }
}

// ── OpenAI-compatibility providers ───────────────────────────────────────────

export function listOpenAICompat(): Promise<OpenAICompatProvider[]> {
  return mgmtGet<OpenAICompatProvider>("/openai-compatibility", "openai-compatibility")
}

export async function putOpenAICompat(list: OpenAICompatProvider[]): Promise<void> {
  await mgmtPut("/openai-compatibility", list)
  log.llm("proxyAdmin: openai-compatibility updated", `${list.length} provider(s)`)
}

// ── Claude (Anthropic-compatible) API-key providers ──────────────────────────

export function listClaudeApiKey(): Promise<ClaudeKeyProvider[]> {
  return mgmtGet<ClaudeKeyProvider>("/claude-api-key", "claude-api-key")
}

export async function putClaudeApiKey(list: ClaudeKeyProvider[]): Promise<void> {
  await mgmtPut("/claude-api-key", list)
  log.llm("proxyAdmin: claude-api-key updated", `${list.length} provider(s)`)
}

// ── Availability probe ───────────────────────────────────────────────────────

export interface ManagementStatus {
  available: boolean
  reason?: string
}

export async function getManagementStatus(): Promise<ManagementStatus> {
  if (!secret()) return { available: false, reason: "MANAGEMENT_SECRET not configured" }
  try {
    await listOpenAICompat()
    return { available: true }
  } catch (e) {
    if (e instanceof ManagementError && e.status === 401) return { available: false, reason: "Management key rejected by proxy (401)" }
    return { available: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

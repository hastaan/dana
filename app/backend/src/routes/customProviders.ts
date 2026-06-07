// Custom API-key providers (OpenAI-compatible + Anthropic-compatible) managed
// through the CLIProxyAPI Management API. Lets a user add e.g. MiniMax by
// API key + base URL from the UI. The proxy is the source of truth — Dana stores
// nothing locally; every read/write goes through proxyAdmin (hot-reloaded).
import { Elysia, t } from "elysia"
import {
  listOpenAICompat,
  putOpenAICompat,
  listClaudeApiKey,
  putClaudeApiKey,
  getManagementStatus,
  ManagementError,
  ManagementUnavailableError,
  type OpenAICompatProvider,
  type ClaudeKeyProvider,
  type ProviderModel,
} from "../llm/proxyAdmin"
import { invalidateVerifiedModels } from "../llm/proxyClient"
import { log } from "../utils/logger"

type Kind = "openai" | "anthropic"

interface CustomProviderView {
  kind: Kind
  id: string // stable identity: openai → name, anthropic → base-url
  name: string
  base_url: string
  models: ProviderModel[]
  key_hint: string
  disabled?: boolean
}

class BadRequestError extends Error {}

// Serialize all mutations: every change is read-modify-write against the proxy's
// whole-list PUT, so two overlapping requests would clobber each other. Single
// in-process queue (admin ops are low-frequency) eliminates the lost-update window.
let writeChain: Promise<unknown> = Promise.resolve()
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn)
  writeChain = run.then(() => {}, () => {})
  return run
}

function keyHint(key: string | undefined): string {
  if (!key) return ""
  const k = key.trim()
  return k.length <= 4 ? "••••" : `••••${k.slice(-4)}`
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function normalizeModels(models: unknown): ProviderModel[] {
  if (!Array.isArray(models)) return []
  return models
    .map((m) => {
      const name = String((m as ProviderModel)?.name ?? "").trim()
      const aliasRaw = (m as ProviderModel)?.alias
      const alias = aliasRaw != null ? String(aliasRaw).trim() : ""
      return alias ? { name, alias } : { name }
    })
    .filter((m) => m.name.length > 0)
}

async function buildView(): Promise<CustomProviderView[]> {
  const [oai, claude] = await Promise.all([listOpenAICompat(), listClaudeApiKey()])
  const views: CustomProviderView[] = []
  for (const p of oai) {
    views.push({
      kind: "openai",
      id: p.name,
      name: p.name,
      base_url: p["base-url"],
      models: p.models ?? [],
      key_hint: keyHint(p["api-key-entries"]?.[0]?.["api-key"]),
      disabled: p.disabled,
    })
  }
  for (const p of claude) {
    views.push({
      kind: "anthropic",
      id: p["base-url"],
      name: hostOf(p["base-url"]) + " (anthropic)",
      base_url: p["base-url"],
      models: p.models ?? [],
      key_hint: keyHint(p["api-key"]),
    })
  }
  return views
}

function errorResponse(set: { status?: number | string }, e: unknown) {
  if (e instanceof BadRequestError) {
    set.status = 400
    return { error: "bad_request", message: e.message }
  }
  if (e instanceof ManagementUnavailableError) {
    set.status = 503
    return { error: "management_unavailable", message: e.message }
  }
  if (e instanceof ManagementError) {
    set.status = e.status === 401 ? 401 : 502
    return { error: "management_error", message: e.message }
  }
  // Anything else here is an unexpected server/upstream fault, not bad client input.
  set.status = 502
  return { error: "upstream_error", message: e instanceof Error ? e.message : String(e) }
}

// Block cross-site browser requests (CSRF) on mutating routes. Browsers set
// Sec-Fetch-Site; non-browser clients (curl, server-side) omit it → allowed.
function crossSiteBlocked(request: Request, set: { status?: number | string }): { error: string; message: string } | null {
  const sfs = request.headers.get("sec-fetch-site")
  if (sfs && sfs !== "same-origin" && sfs !== "same-site" && sfs !== "none") {
    set.status = 403
    return { error: "forbidden", message: "Cross-site request blocked" }
  }
  return null
}

export const customProvidersRouter = new Elysia({ prefix: "/api/providers/custom" })
  .get("/", async ({ set }) => {
    try {
      return { providers: await buildView() }
    } catch (e) {
      return errorResponse(set, e)
    }
  })

  .get("/status", async () => {
    return getManagementStatus()
  })

  // Create or update (upsert by id). On edit, a blank api_key preserves the existing
  // key, and all fields not managed by Dana (disabled, prefix, proxy-url, extra keys)
  // are preserved by spreading the existing entry.
  .post(
    "/",
    async ({ body, set, request }) => {
      const blocked = crossSiteBlocked(request, set)
      if (blocked) return blocked

      const kind = body.kind as Kind
      const baseUrl = body.base_url.trim()
      const apiKey = (body.api_key ?? "").trim()
      const models = normalizeModels(body.models)

      if (!/^https?:\/\//i.test(baseUrl)) {
        set.status = 400
        return { error: "bad_request", message: "base_url must start with http:// or https://" }
      }
      if (kind === "openai") {
        const name = (body.name ?? "").trim()
        if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) {
          set.status = 400
          return { error: "bad_request", message: "name is required (letters, digits, dot, dash, underscore)" }
        }
      } else if (kind !== "anthropic") {
        set.status = 400
        return { error: "bad_request", message: "kind must be 'openai' or 'anthropic'" }
      }

      try {
        await serialize(async () => {
          if (kind === "openai") {
            const name = body.name!.trim()
            const list = await listOpenAICompat()
            const idx = list.findIndex((p) => p.name === name)
            const base = idx >= 0 ? list[idx] : undefined
            const existingEntries = base?.["api-key-entries"] ?? []
            const effectiveKey = apiKey || existingEntries[0]?.["api-key"]
            if (!effectiveKey) throw new BadRequestError("api_key is required for a new provider")
            const provider: OpenAICompatProvider = {
              ...(base ?? ({} as OpenAICompatProvider)),
              name,
              "base-url": baseUrl,
              "api-key-entries": [
                { ...(existingEntries[0] ?? {}), "api-key": effectiveKey },
                ...existingEntries.slice(1),
              ],
              models,
            }
            if (idx >= 0) list[idx] = provider
            else list.push(provider)
            await putOpenAICompat(list)
          } else {
            const list = await listClaudeApiKey()
            const idx = list.findIndex((p) => p["base-url"] === baseUrl)
            const base = idx >= 0 ? list[idx] : undefined
            const effectiveKey = apiKey || base?.["api-key"]
            if (!effectiveKey) throw new BadRequestError("api_key is required for a new provider")
            const provider: ClaudeKeyProvider = {
              ...(base ?? ({} as ClaudeKeyProvider)),
              "api-key": effectiveKey,
              "base-url": baseUrl,
              models,
            }
            if (idx >= 0) list[idx] = provider
            else list.push(provider)
            await putClaudeApiKey(list)
          }
        })

        invalidateVerifiedModels()
        log.llm("Custom provider upserted", `${kind} ${baseUrl}`)
        return { ok: true }
      } catch (e) {
        return errorResponse(set, e)
      }
    },
    {
      body: t.Object({
        kind: t.Union([t.Literal("openai"), t.Literal("anthropic")]),
        name: t.Optional(t.String()),
        base_url: t.String(),
        api_key: t.Optional(t.String()),
        models: t.Optional(
          t.Array(t.Object({ name: t.String(), alias: t.Optional(t.String()) })),
        ),
      }),
    },
  )

  // Delete by kind + id (id = name for openai, base-url for anthropic)
  .delete("/", async ({ query, set, request }) => {
    const blocked = crossSiteBlocked(request, set)
    if (blocked) return blocked

    const kind = query.kind as Kind
    const id = query.id as string
    if (!kind || !id) {
      set.status = 400
      return { error: "bad_request", message: "kind and id query params are required" }
    }
    if (kind !== "openai" && kind !== "anthropic") {
      set.status = 400
      return { error: "bad_request", message: "kind must be 'openai' or 'anthropic'" }
    }

    try {
      let removed = false
      await serialize(async () => {
        if (kind === "openai") {
          const list = await listOpenAICompat()
          const next = list.filter((p) => p.name !== id)
          removed = next.length !== list.length
          if (removed) await putOpenAICompat(next)
        } else {
          const list = await listClaudeApiKey()
          const next = list.filter((p) => p["base-url"] !== id)
          removed = next.length !== list.length
          if (removed) await putClaudeApiKey(next)
        }
      })
      if (!removed) {
        set.status = 404
        return { error: "not_found", message: `No ${kind} provider matching "${id}"` }
      }
      invalidateVerifiedModels()
      log.llm("Custom provider deleted", `${kind} ${id}`)
      return { ok: true }
    } catch (e) {
      return errorResponse(set, e)
    }
  })

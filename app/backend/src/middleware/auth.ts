// Env-gated bearer-token auth for /api/* (⇄ server-py api/auth.py ApiTokenMiddleware).
//
// OFF by default: if env DANA_API_TOKEN is unset/empty, every request passes through unchanged
// (current behavior). If it is set, /api/* requires `Authorization: Bearer <token>` and returns
// 401 JSON otherwise.
//
// Exemptions:
//   • health probes: /health, /api/health
//   • SSE stream endpoints (path ends with /stream): EventSource can't set headers, so they
//     may instead authenticate with a `?token=<token>` query param.
//
// Wired as an Elysia plugin in index.ts (before the routers) so it covers every router uniformly.
import { Elysia } from "elysia"

// Paths that never require auth (health probes). The SPA/static mount and non-/api routes are
// also exempt — we only guard the JSON API surface.
const EXEMPT_PATHS: ReadonlySet<string> = new Set(["/health", "/api/health"])

// The configured API token, or "" when auth is disabled. Read live from the env so the gate
// reflects the process environment at request time.
function expectedToken(): string {
  return (process.env.DANA_API_TOKEN || "").trim()
}

// Pull the bearer token from the Authorization header, or — for SSE stream endpoints, where
// EventSource cannot set headers — from the `?token=` query param.
function presentedToken(request: Request, path: string): string | null {
  const auth = request.headers.get("authorization") || ""
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim()
  }
  if (path.endsWith("/stream")) {
    const tok = new URL(request.url).searchParams.get("token")
    if (tok) return tok.trim()
  }
  return null
}

// Require `Authorization: Bearer <DANA_API_TOKEN>` on /api/* when the env var is set.
// No-op when DANA_API_TOKEN is unset/empty, so the default deployment is unaffected.
export const authPlugin = new Elysia({ name: "auth" })
  .onRequest(({ request, set }) => {
    const expected = expectedToken()
    if (!expected) return  // auth disabled — pass through

    const path = new URL(request.url).pathname
    if (!path.startsWith("/api/")) return   // only guard the API surface
    if (EXEMPT_PATHS.has(path)) return        // health probes always allowed

    if (presentedToken(request, path) !== expected) {
      set.status = 401
      return { status: "error", message: "unauthorized" }
    }
  })

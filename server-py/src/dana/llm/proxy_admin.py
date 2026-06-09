"""Typed async client for the CLIProxyAPI Management API (⇄ TS llm/proxyAdmin.ts).

  Base:  $PROXY_BASE_URL/v0/management
  Auth:  Authorization: Bearer <MANAGEMENT_SECRET>
  GET/PUT/DELETE /openai-compatibility   (wrapper key "openai-compatibility")
  GET/PUT        /claude-api-key          (read-modify-write PUT for all mutations)

PUT bodies contain plaintext API keys, so callers must never echo them back to the browser.
"""
import httpx

from ..config import settings


class ManagementUnavailable(Exception):
    """Proxy/management API unreachable or disabled."""


class ManagementError(Exception):
    def __init__(self, message: str, status: int = 500):
        super().__init__(message)
        self.status = status


def _base() -> str:
    return settings.proxy_base_url.rstrip("/") + "/v0/management"


def _secret() -> str:
    sk = settings.management_secret
    if not sk:
        raise ManagementUnavailable(
            "MANAGEMENT_SECRET is not set — cannot reach the CLIProxyAPI management API. "
            "Add remote-management.secret-key to the proxy config and set MANAGEMENT_SECRET to match."
        )
    return sk


async def _fetch(method: str, path: str, body=None) -> httpx.Response:
    headers = {"Authorization": f"Bearer {_secret()}", "Content-Type": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            return await client.request(method, f"{_base()}{path}", headers=headers, json=body)
    except httpx.HTTPError as e:
        raise ManagementUnavailable(f"CLIProxyAPI management API unreachable at {_base()}: {e}") from e


async def _get_list(path: str, key: str) -> list[dict]:
    res = await _fetch("GET", path)
    if res.status_code == 401:
        raise ManagementError("Proxy management rejected the key (401)", 401)
    if res.status_code == 404:
        raise ManagementUnavailable(f"Endpoint {path} not found (404) — management disabled or unsupported")
    if res.status_code >= 400:
        raise ManagementError(f"GET {path} failed (HTTP {res.status_code})", res.status_code)
    data = res.json()
    return data.get(key) or [] if isinstance(data, dict) else (data or [])


async def _put_list(path: str, lst: list[dict]) -> None:
    res = await _fetch("PUT", path, lst)
    if res.status_code >= 400:
        raise ManagementError(f"PUT {path} failed (HTTP {res.status_code})", res.status_code)


# ── openai-compatibility ────────────────────────────────────────────────────────
async def list_openai_compat() -> list[dict]:
    return await _get_list("/openai-compatibility", "openai-compatibility")


async def put_openai_compat(lst: list[dict]) -> None:
    await _put_list("/openai-compatibility", lst)


# ── claude-api-key ──────────────────────────────────────────────────────────────
async def list_claude_key() -> list[dict]:
    return await _get_list("/claude-api-key", "claude-api-key")


async def put_claude_key(lst: list[dict]) -> None:
    await _put_list("/claude-api-key", lst)


async def management_status() -> dict:
    """Best-effort reachability probe."""
    try:
        await list_openai_compat()
        return {"reachable": True}
    except ManagementUnavailable as e:
        return {"reachable": False, "reason": str(e)}
    except ManagementError as e:
        return {"reachable": False, "reason": str(e), "status": e.status}


# ── OAuth (interactive provider login) ⇄ TS proxyAdmin getProviderAuthUrl / getAuthStatus ──
AUTH_URL_ENDPOINT = {
    "claude": "anthropic-auth-url",
    "openai": "codex-auth-url",
    "gemini": "gemini-cli-auth-url",
}


async def _get_json(path: str) -> dict:
    res = await _fetch("GET", path)
    if res.status_code == 401:
        raise ManagementError("Proxy management rejected the key (401)", 401)
    if res.status_code == 404:
        raise ManagementUnavailable(f"Endpoint {path} not found (404) — management disabled or unsupported")
    if res.status_code >= 400:
        raise ManagementError(f"GET {path} failed (HTTP {res.status_code})", res.status_code)
    try:
        data = res.json()
    except Exception as e:  # noqa: BLE001 — non-JSON body, ⇄ TS mgmtJson 502
        raise ManagementError(f"GET {path} returned non-JSON", 502) from e
    return data if isinstance(data, dict) else {}


async def get_provider_auth_url(endpoint: str) -> dict:
    """⇄ getProviderAuthUrl: GET /{anthropic|codex|gemini-cli}-auth-url → {url, state}."""
    return await _get_json(f"/{endpoint}")


async def get_auth_status(state: str) -> dict:
    """⇄ getAuthStatus: GET /get-auth-status?state=<s> → {status}."""
    from urllib.parse import quote
    return await _get_json(f"/get-auth-status?state={quote(state, safe='')}")

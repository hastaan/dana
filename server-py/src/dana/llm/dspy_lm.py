"""DSPy LM configuration against CLIProxyAPI (OpenAI-compatible).

Sync helpers (DSPy programs run synchronously, off the event loop in a worker thread),
mirroring the model-availability fallback from modelCatalog.ts.
"""
import dspy
import httpx

from ..config import settings


def _models_sync() -> list[str]:
    r = httpx.get(
        f"{settings.proxy_base_url}/v1/models",
        headers={"Authorization": f"Bearer {settings.proxy_api_key}"},
        timeout=10.0,
    )
    r.raise_for_status()
    return [m["id"] for m in r.json().get("data", [])]


def pick_model(preferred: list[str] | None = None) -> str:
    """Return the first preferred model that's actually served, else first available."""
    avail = _models_sync()
    for p in preferred or []:
        if p in avail:
            return p
    return avail[0] if avail else "minimax-m3"


def make_lm(model: str | None = None, **kwargs) -> dspy.LM:
    m = model or pick_model(["minimax-m3", "qwen3-coder-plus"])
    return dspy.LM(
        f"openai/{m}",
        api_base=f"{settings.proxy_base_url}/v1",
        api_key=settings.proxy_api_key,
        **kwargs,
    )


def configure(model: str | None = None, **kwargs) -> dspy.LM:
    lm = make_lm(model, **kwargs)
    dspy.configure(lm=lm)
    return lm

"""DSPy LM configuration against CLIProxyAPI (OpenAI-compatible).

Sync helpers (DSPy programs run synchronously, off the event loop in a worker thread),
mirroring the model-availability fallback from modelCatalog.ts.

Robustness (Phase A of the internet-lookup workflow): every completion is routed through a
`<think>`-stripping LM so MiniMax's reasoning blocks never poison typed parsing (ports the
job of the reference stack's strip-think proxy into our single LM chokepoint), and litellm
retries with backoff on transient proxy/rate-limit errors.
"""
import dspy
import httpx

from ..config import settings
from .think import strip_think


class ThinkStrippingLM(dspy.LM):
    """dspy.LM that strips `<think>` blocks from every returned completion."""

    def __call__(self, *args, **kwargs):
        outputs = super().__call__(*args, **kwargs)
        cleaned = []
        for o in outputs:
            if isinstance(o, str):
                cleaned.append(strip_think(o))
            elif isinstance(o, dict) and isinstance(o.get("text"), str):
                cleaned.append({**o, "text": strip_think(o["text"])})
            else:
                cleaned.append(o)
        return cleaned


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
    # num_retries → litellm exponential backoff on 429/5xx/transient proxy errors.
    kwargs.setdefault("num_retries", 3)
    return ThinkStrippingLM(
        f"openai/{m}",
        api_base=f"{settings.proxy_base_url}/v1",
        api_key=settings.proxy_api_key,
        **kwargs,
    )


def configure(model: str | None = None, **kwargs) -> dspy.LM:
    lm = make_lm(model, **kwargs)
    dspy.configure(lm=lm)
    return lm

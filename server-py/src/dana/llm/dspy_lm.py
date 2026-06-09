"""DSPy LM configuration against CLIProxyAPI (OpenAI-compatible).

Sync helpers (DSPy programs run synchronously, off the event loop in a worker thread),
mirroring the model-availability fallback from modelCatalog.ts.

Robustness (Phase A of the internet-lookup workflow): every completion is routed through a
`<think>`-stripping LM so MiniMax's reasoning blocks never poison typed parsing (ports the
job of the reference stack's strip-think proxy into our single LM chokepoint), and litellm
retries with backoff on transient proxy/rate-limit errors.
"""
import contextlib

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


def _apply_overrides() -> None:
    """Install any operator instruction-overrides onto the DSPy signature classes IN PLACE
    (a process-wide mutation), BEFORE the caller constructs its DSPy modules — every stage
    builds its modules right after entering the LM context. With no overrides set this
    restores every signature to its shipped default → a no-op. Imported lazily to avoid a
    circular import (llm.prompts imports the signatures); a failure here can never break LM
    setup."""
    try:
        from . import prompts as _prompts
        _prompts.apply_overrides()
    except Exception:  # noqa: BLE001 — overrides are best-effort; never break LM setup
        pass


def configure(model: str | None = None, **kwargs) -> dspy.LM:
    """Set the PROCESS-WIDE default DSPy LM. Call ONCE from the main thread at startup
    (see main.lifespan). DSPy's settings can only be (re)configured by the thread that first
    called dspy.configure(), so worker threads MUST NOT call this — they use `lm_context()`
    (thread-local) instead. Safe to call repeatedly from the owning (main) thread."""
    lm = make_lm(model, **kwargs)
    dspy.configure(lm=lm)
    _apply_overrides()
    return lm


@contextlib.contextmanager
def lm_context(model: str | None = None, **kwargs):
    """Per-request LM setup usable from ANY thread (e.g. asyncio.to_thread workers).

    Uses dspy.context() — a thread-local override (contextvars) — instead of dspy.configure(),
    which DSPy restricts to the single thread that first configured it (configuring from a
    worker raises 'dspy.settings can only be changed by the thread that initially configured
    it'). Builds a fresh LM, applies the instruction-overrides (global Signature mutation, so
    modules constructed INSIDE the `with` pick them up), then enters dspy.context(lm=lm).

        with dspy_lm.lm_context():
            module(...)
    """
    lm = make_lm(model, **kwargs)
    _apply_overrides()
    with dspy.context(lm=lm):
        yield lm

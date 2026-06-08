"""`<think>` stripping — dependency-free so both the async chokepoint (lm.py) and the DSPy
LM (dspy_lm.py) can use it without importing the heavy `dspy`/`litellm` stack.

MiniMax (and other reasoning models) emit `<think>…</think>` blocks that break typed parsing
downstream. This ports the job of the reference stack's strip-think proxy into Dana itself.
"""
import re

_THINK_RE = re.compile(r"<think>.*?</think>\s*", re.DOTALL | re.IGNORECASE)
_ORPHAN_CLOSE_RE = re.compile(r"^.*?</think>\s*", re.DOTALL | re.IGNORECASE)


def strip_think(text: str) -> str:
    """Remove `<think>…</think>` reasoning. Handles a closed block and the case where the
    opening tag was dropped but a stray `</think>` remains (keep only what follows it)."""
    if not isinstance(text, str) or "think>" not in text.lower():
        return text
    out = _THINK_RE.sub("", text)
    if "</think>" in out.lower():  # orphan close with no open → keep the tail
        out = _ORPHAN_CLOSE_RE.sub("", out)
    return out.lstrip()

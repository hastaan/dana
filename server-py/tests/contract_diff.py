#!/usr/bin/env python3
"""Contract-diff harness — TS (:3000) vs server-py (:3001), read-only endpoints.

Issues the SAME GET request to a fixed list of read endpoints against both backends
and prints a per-endpoint PASS / DIFF report: status-code match + a recursive JSON
*shape* (key-set + leaf-type) diff. Volatile fields (timestamps, ids, durations, …)
are ignored so re-running the pipeline doesn't show up as a contract break.

This is a parity probe for the cutover (see docs/CUTOVER.md), NOT a value/golden test:
it compares response *structure*, not the concrete forecasts/text inside.

Design constraints:
  * Standard-library only (urllib) — no httpx/requests, so it runs even without the
    server-py venv installed.
  * Does NOT require both servers to be up. A connection failure on either side is
    reported as 'unreachable' for that endpoint; the script never raises/crashes.
  * Read-only: every request is a GET. It never mutates state, never runs the
    pipeline, never triggers an LLM/web-search call.

Usage:
    python tests/contract_diff.py <TOPIC_ID>
    BASE_TS=http://localhost:3000 BASE_PY=http://localhost:3001 \
        python tests/contract_diff.py <TOPIC_ID>

    # optional: send a bearer token if the backends are auth-gated
    DANA_API_TOKEN=... python tests/contract_diff.py <TOPIC_ID>

Exit code: 0 if every reachable endpoint PASSes (or is unreachable on BOTH sides),
1 if any reachable pair DIFFs. Unreachable-on-one-side is reported, not failed,
because the harness is explicitly allowed to run with a server down.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

# Defaults match the cutover layout: TS on :3000, server-py on :3001. Overridable
# via env so the same harness works against staging / alternate ports.
BASE_TS = os.environ.get("BASE_TS", "http://localhost:3000").rstrip("/")
BASE_PY = os.environ.get("BASE_PY", "http://localhost:3001").rstrip("/")
TIMEOUT = float(os.environ.get("CONTRACT_DIFF_TIMEOUT", "10"))
API_TOKEN = os.environ.get("DANA_API_TOKEN", "").strip()

# Volatile / non-deterministic field names to ignore in the shape diff. These differ
# run-to-run (or backend-to-backend) without being a contract break: timestamps,
# surrogate ids, monotonic counters, free-text bodies, durations, token counts.
VOLATILE_KEYS = frozenset(
    {
        "created_at", "updated_at", "createdAt", "updatedAt",
        "resolved_at", "resolvedAt", "timestamp", "ts", "time", "date",
        "id", "session_id", "sessionId", "version", "versions",
        "duration", "duration_ms", "durationMs", "latency", "latency_ms",
        "elapsed", "elapsed_ms", "tokens", "token_count", "cost",
        "started_at", "startedAt", "finished_at", "finishedAt",
        "last_run", "lastRun", "uuid", "hash", "etag",
    }
)


def _endpoints(topic_id: str) -> list[tuple[str, str]]:
    """(label, path) for every read endpoint in the cutover contract.

    Topic-scoped reads live under /api/topics/<id>/... in BOTH backends (TS Elysia
    prefix `/api/topics/:id`, server-py FastAPI `/api/topics/{topic_id}`), so the
    same literal path hits both.
    """
    t = f"/api/topics/{topic_id}"
    return [
        ("GET /api/topics", "/api/topics"),
        ("GET /api/topics/:id", t),
        ("GET /api/topics/:id/parties", f"{t}/parties"),
        ("GET /api/topics/:id/clues", f"{t}/clues"),
        ("GET /api/topics/:id/verdict", f"{t}/verdict"),
        ("GET /api/topics/:id/expert-council", f"{t}/expert-council"),
        ("GET /api/topics/:id/representatives", f"{t}/representatives"),
        ("GET /api/topics/:id/forum", f"{t}/forum"),
        ("GET /api/calibration", "/api/calibration"),
        ("GET /api/settings", "/api/settings"),
        ("GET /api/providers/custom", "/api/providers/custom"),
        ("GET /api/prompts", "/api/prompts"),
        ("GET /api/prompts/tool-catalog", "/api/prompts/tool-catalog"),
        ("GET /api/health", "/api/health"),
    ]


def _fetch(base: str, path: str) -> dict:
    """GET base+path. Returns a result dict, NEVER raises.

    keys: ok(bool), reachable(bool), status(int|None), json(parsed|None),
          json_ok(bool), error(str|None)
    """
    url = base + path
    req = urllib.request.Request(url, method="GET")
    req.add_header("Accept", "application/json")
    if API_TOKEN:
        req.add_header("Authorization", f"Bearer {API_TOKEN}")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            status = resp.getcode()
            raw = resp.read()
    except urllib.error.HTTPError as e:  # 4xx/5xx — reachable, just non-2xx
        status = e.code
        try:
            raw = e.read()
        except Exception:
            raw = b""
    except (urllib.error.URLError, ConnectionError, OSError, TimeoutError) as e:
        # Connection refused / DNS / timeout → server is down or wrong port.
        return {"ok": False, "reachable": False, "status": None,
                "json": None, "json_ok": False, "error": str(e)}
    except Exception as e:  # never let an unexpected parse/socket error crash the run
        return {"ok": False, "reachable": False, "status": None,
                "json": None, "json_ok": False, "error": f"unexpected: {e}"}

    parsed = None
    json_ok = False
    if raw:
        try:
            parsed = json.loads(raw.decode("utf-8", errors="replace"))
            json_ok = True
        except Exception:
            parsed = None
            json_ok = False
    else:
        # empty body is valid JSON-shape-wise (treated as null)
        json_ok = True
    return {"ok": 200 <= status < 300, "reachable": True, "status": status,
            "json": parsed, "json_ok": json_ok, "error": None}


def _shape(value, _depth: int = 0):
    """Recursive structural fingerprint of a JSON value, ignoring volatile keys.

    - dict  -> {key: shape(value)} with VOLATILE_KEYS dropped
    - list  -> ["[]"] + shape of the *first* element (lists are homogeneous in the
               contract; we compare element shape, not length, so re-runs that add
               rows don't diff). Empty list -> "[]".
    - scalar-> its type name ("str"/"int"/"float"/"bool"/"null")
    Depth-capped so any accidental cycle / very deep nesting can't run away.
    """
    if _depth > 40:
        return "…"
    if isinstance(value, dict):
        out = {}
        for k in sorted(value.keys()):
            if k in VOLATILE_KEYS:
                continue
            out[k] = _shape(value[k], _depth + 1)
        return out
    if isinstance(value, list):
        if not value:
            return "[]"
        # Merge keys across elements so an optional field present on only some rows
        # is still part of the shape (reduces false DIFFs from sparse arrays).
        if all(isinstance(el, dict) for el in value):
            merged: dict = {}
            for el in value:
                for k in el:
                    if k in VOLATILE_KEYS:
                        continue
                    if k not in merged:
                        merged[k] = _shape(el[k], _depth + 2)
            return ["[]", merged]
        return ["[]", _shape(value[0], _depth + 1)]
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, int):
        return "int"
    if isinstance(value, float):
        return "float"
    if isinstance(value, str):
        return "str"
    return type(value).__name__


def _diff_shapes(a, b, path: str = "") -> list[str]:
    """Return human-readable difference lines between two shape fingerprints."""
    diffs: list[str] = []
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            p = f"{path}.{k}" if path else k
            if k not in a:
                diffs.append(f"  + only in PY: {p} ({_brief(b[k])})")
            elif k not in b:
                diffs.append(f"  - only in TS: {p} ({_brief(a[k])})")
            else:
                diffs.extend(_diff_shapes(a[k], b[k], p))
        return diffs
    if isinstance(a, list) and isinstance(b, list):
        # both are ["[]"] or ["[]", shape]
        sa = a[1] if len(a) > 1 else "[]"
        sb = b[1] if len(b) > 1 else "[]"
        diffs.extend(_diff_shapes(sa, sb, f"{path}[]"))
        return diffs
    if a != b:
        diffs.append(f"  ~ type/shape differs at {path or '<root>'}: TS={_brief(a)} PY={_brief(b)}")
    return diffs


def _brief(shape) -> str:
    if isinstance(shape, dict):
        return "{" + ",".join(sorted(shape)[:8]) + ("…" if len(shape) > 8 else "") + "}"
    if isinstance(shape, list):
        return "[…]"
    return str(shape)


def _compare(label: str, ts: dict, py: dict) -> tuple[str, list[str]]:
    """Return (verdict, detail_lines) for one endpoint pair."""
    # Both sides down → not a failure (harness may run with servers off).
    if not ts["reachable"] and not py["reachable"]:
        return "UNREACHABLE", ["  both TS and PY unreachable"]
    if not ts["reachable"]:
        return "UNREACHABLE", [f"  TS unreachable ({ts['error']})"]
    if not py["reachable"]:
        return "UNREACHABLE", [f"  PY unreachable ({py['error']})"]

    detail: list[str] = []
    verdict = "PASS"

    if ts["status"] != py["status"]:
        verdict = "DIFF"
        detail.append(f"  status: TS={ts['status']} PY={py['status']}")

    # Only diff bodies when both returned a 2xx; non-2xx (e.g. 404 for a missing
    # topic or the known prompts gap on PY) is captured by the status line above.
    if ts["ok"] and py["ok"]:
        if not ts["json_ok"] or not py["json_ok"]:
            verdict = "DIFF"
            detail.append(f"  body not JSON: TS_json_ok={ts['json_ok']} PY_json_ok={py['json_ok']}")
        else:
            shape_diffs = _diff_shapes(_shape(ts["json"]), _shape(py["json"]))
            if shape_diffs:
                verdict = "DIFF"
                detail.append(f"  shape diffs ({len(shape_diffs)}):")
                detail.extend(shape_diffs[:30])
                if len(shape_diffs) > 30:
                    detail.append(f"  … {len(shape_diffs) - 30} more")
    elif verdict == "PASS":
        # statuses matched and both non-2xx → contract-equivalent (e.g. both 404)
        detail.append(f"  both non-2xx (status={ts['status']}) — equivalent")

    return verdict, detail


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        print(__doc__)
        return 0 if (len(argv) >= 2 and argv[1] in ("-h", "--help")) else 2
    topic_id = argv[1]

    print(f"Contract diff  TS={BASE_TS}  PY={BASE_PY}  topic={topic_id}")
    print("=" * 72)

    n_pass = n_diff = n_unreach = 0
    for label, path in _endpoints(topic_id):
        ts = _fetch(BASE_TS, path)
        py = _fetch(BASE_PY, path)
        verdict, detail = _compare(label, ts, py)
        if verdict == "PASS":
            n_pass += 1
        elif verdict == "DIFF":
            n_diff += 1
        else:
            n_unreach += 1
        sts = ts["status"] if ts["reachable"] else "—"
        spy = py["status"] if py["reachable"] else "—"
        print(f"[{verdict:11}] {label:38} TS={sts} PY={spy}")
        for line in detail:
            if verdict != "PASS":
                print(line)

    print("=" * 72)
    print(f"PASS={n_pass}  DIFF={n_diff}  UNREACHABLE={n_unreach}")
    return 1 if n_diff else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

import { useCallback, useEffect, useRef, useState } from "react"

// SHARED SSE STREAMING CONTRACT (must match py + ts backends exactly):
//   GET /api/research/lookup/stream?query=<q>&level=<deep_lookup|deep_search>&breadth=<clue|topic|article>
//   → text/event-stream. Server emits unnamed SSE events ("data: <json>\n\n"):
//     • live trace events verbatim from the tier's emit() dicts:
//         {"type":"think","icon","label","detail?"} / {"type":"progress","stage","pct","msg"}
//     • exactly one FINAL event: {"type":"result","result": <full LookupResponse>}
//     then the server closes the stream.
// The "quick" tier does NOT stream — callers keep it on the plain POST flow.

// A single live-trace line shown in the trace panel.
export interface TraceEvent {
  type: "think" | "progress"
  // think: icon/label/detail · progress: stage/pct/msg
  icon?: string
  label?: string
  detail?: string
  stage?: string
  pct?: number
  msg?: string
}

// Raw events as they arrive over the wire (trace lines + the one terminal result).
type StreamEvent =
  | (TraceEvent & { type: "think" | "progress" })
  | { type: "result"; result: unknown }
  | { type: "error"; message?: string }
  | { type: "ping" }

interface StreamParams {
  query: string
  level: "deep_lookup" | "deep_search"
  breadth?: string
}

interface UseResearchStreamReturn<R> {
  trace: TraceEvent[]
  streaming: boolean
  // Opens the EventSource. Resolves with the final result on {"type":"result"},
  // or rejects (so callers can fall back to POST) on transport/protocol failure.
  start: (params: StreamParams) => Promise<R>
  reset: () => void
}

export function useResearchStream<R = unknown>(): UseResearchStreamReturn<R> {
  const [trace, setTrace] = useState<TraceEvent[]>([])
  const [streaming, setStreaming] = useState(false)
  const esRef = useRef<EventSource | null>(null)

  const close = useCallback(() => {
    if (esRef.current) {
      esRef.current.close()
      esRef.current = null
    }
  }, [])

  const reset = useCallback(() => {
    close()
    setTrace([])
    setStreaming(false)
  }, [close])

  // Tear down any open stream on unmount.
  useEffect(() => close, [close])

  const start = useCallback((params: StreamParams) => {
    return new Promise<R>((resolve, reject) => {
      // Native guard — if EventSource is unavailable, let the caller fall back to POST.
      if (typeof window === "undefined" || typeof window.EventSource === "undefined") {
        reject(new Error("EventSource unsupported"))
        return
      }

      close()
      setTrace([])
      setStreaming(true)

      const qs = new URLSearchParams({ query: params.query, level: params.level })
      if (params.breadth) qs.set("breadth", params.breadth)
      // TODO(auth): if DANA_API_TOKEN-style auth is enabled, EventSource can't set headers,
      // so pass the token via query string here (e.g. read from import.meta.env.VITE_API_TOKEN).
      // Omitted for now — do not hardcode secrets.

      const es = new EventSource(`/api/research/lookup/stream?${qs.toString()}`)
      esRef.current = es

      // Resolves exactly once; subsequent events/errors are ignored.
      let settled = false

      es.onmessage = (e) => {
        let event: StreamEvent
        try {
          event = JSON.parse(e.data) as StreamEvent
        } catch {
          return // ignore malformed
        }
        if (event.type === "ping") return
        if (event.type === "think" || event.type === "progress") {
          setTrace((prev) => [...prev, event])
          return
        }
        if (event.type === "result") {
          settled = true
          close()
          setStreaming(false)
          resolve((event as { result: R }).result)
          return
        }
        if (event.type === "error") {
          settled = true
          close()
          setStreaming(false)
          reject(new Error(event.message || "Research stream error."))
        }
      }

      es.onerror = () => {
        // EventSource auto-reconnects on transient errors, but if we never got a result
        // we treat it as a failure and let the caller fall back to POST.
        if (settled) return
        settled = true
        close()
        setStreaming(false)
        reject(new Error("EventSource connection failed."))
      }
    })
  }, [close])

  return { trace, streaming, start, reset }
}

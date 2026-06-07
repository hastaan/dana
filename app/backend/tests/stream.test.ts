import { describe, it, expect } from "bun:test"
import { emit, subscribe, makeProgressEmitter } from "../src/routes/stream"

describe("SSE event bus", () => {
  it("delivers events to subscribers", async () => {
    const received: unknown[] = []
    const unsub = subscribe("topic-test", (e) => received.push(e))

    emit("topic-test", { type: "progress", stage: "discovery", pct: 0.5, msg: "halfway" })
    emit("topic-test", { type: "stage_complete", stage: "discovery" })

    unsub()

    expect(received).toHaveLength(2)
    expect((received[0] as any).type).toBe("progress")
    expect((received[0] as any).pct).toBe(0.5)
    expect((received[1] as any).type).toBe("stage_complete")
  })

  it("does not deliver events after unsubscribe", async () => {
    const received: unknown[] = []
    const unsub = subscribe("topic-unsub-test", (e) => received.push(e))

    emit("topic-unsub-test", { type: "ping" })
    unsub()
    emit("topic-unsub-test", { type: "ping" })

    expect(received).toHaveLength(1)
  })

  it("makeProgressEmitter emits progress events", async () => {
    const received: unknown[] = []
    const unsub = subscribe("topic-emitter-test", (e) => received.push(e))

    const emitter = makeProgressEmitter("topic-emitter-test", "clue_gathering")
    emitter("Fetching source 3 of 10", 0.3)

    unsub()

    expect(received).toHaveLength(1)
    const e = received[0] as any
    expect(e.type).toBe("progress")
    expect(e.stage).toBe("clue_gathering")
    expect(e.pct).toBe(0.3)
    expect(e.msg).toBe("Fetching source 3 of 10")
  })

  it("SSE HTTP endpoint returns text/event-stream", async () => {
    // Start server on a test port
    const { Elysia } = await import("elysia")
    const { streamRouter } = await import("../src/routes/stream")
    const testApp = new Elysia().use(streamRouter).listen(3099)

    await new Promise(r => setTimeout(r, 100))

    const controller = new AbortController()
    setTimeout(() => controller.abort(), 500)

    try {
      const res = await fetch("http://localhost:3099/api/topics/my-topic/stream", {
        signal: controller.signal,
      })
      expect(res.headers.get("content-type")).toContain("text/event-stream")
    } catch (e: any) {
      // AbortError is expected — we just needed the headers
      if (!e.message?.includes("abort") && !e.message?.includes("Abort")) throw e
    } finally {
      testApp.stop()
    }
  })
})

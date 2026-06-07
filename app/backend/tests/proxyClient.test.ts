import { describe, it, expect } from "bun:test"
import { fetchAvailableModels, chatCompletion } from "../src/llm/proxyClient"

describe("ProxyClient", () => {
  it("fetches available models from proxy", async () => {
    const models = await fetchAvailableModels()
    expect(Array.isArray(models)).toBe(true)
    console.log(`Found ${models.length} models:`, models.map(m => m.id))
  })

  it("completes a simple chat message", async () => {
    const models = await fetchAvailableModels()
    if (models.length === 0) {
      console.warn("No models available — skipping completion test")
      return
    }

    // prefer haiku-4-5 (confirmed available), fall back to first model
    const model = models.find(m => m.id === "claude-haiku-4-5-20251001")
      ?? models.find(m => m.id.includes("haiku-4-5"))
      ?? models[0]

    const res = await chatCompletion({
      model: model.id,
      messages: [
        { role: "user", content: "Reply with exactly: pong" }
      ],
      max_tokens: 10,
    })

    expect(res.choices.length).toBeGreaterThan(0)
    const text = res.choices[0].message.content
    expect(typeof text).toBe("string")
    expect(text.length).toBeGreaterThan(0)
    console.log("Model response:", text)
  })
})

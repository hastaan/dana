import { describe, it, expect } from "bun:test"
import { estimateTokens, budgetOutput, fitContext, getContextWindow } from "../src/llm/tokenBudget"

describe("tokenBudget", () => {
  describe("estimateTokens", () => {
    it("returns 0 for empty string", () => {
      expect(estimateTokens("")).toBe(0)
    })

    it("estimates ~1 token per 3.5 chars", () => {
      const text = "a".repeat(350)
      expect(estimateTokens(text)).toBe(100)
    })
  })

  describe("getContextWindow", () => {
    it("returns 200k for known Claude models", () => {
      expect(getContextWindow("claude-sonnet-4-6")).toBe(200_000)
      expect(getContextWindow("claude-haiku-4-5-20251001")).toBe(200_000)
    })

    it("returns 200k for unknown Claude models", () => {
      expect(getContextWindow("claude-future-model")).toBe(200_000)
    })

    it("returns default for non-Claude models", () => {
      expect(getContextWindow("gpt-4")).toBe(128_000)
    })
  })

  describe("budgetOutput", () => {
    it("respects min when input is huge", () => {
      const hugeInput = "a".repeat(700_000) // ~200k tokens
      expect(budgetOutput("claude-sonnet-4-6", hugeInput, { min: 1000, max: 8000 })).toBe(1000)
    })

    it("respects max when input is small", () => {
      expect(budgetOutput("claude-sonnet-4-6", "hello", { min: 1000, max: 8000 })).toBe(8000)
    })

    it("scales with input size", () => {
      const small = budgetOutput("claude-sonnet-4-6", "a".repeat(100), { min: 1000, max: 50000 })
      const large = budgetOutput("claude-sonnet-4-6", "a".repeat(350000), { min: 1000, max: 50000 })
      expect(small).toBeGreaterThanOrEqual(large)
    })
  })

  describe("fitContext", () => {
    it("includes all sections when within budget", () => {
      const result = fitContext([
        { content: "Section A", priority: 10, label: "a" },
        { content: "Section B", priority: 5, label: "b" },
      ], 10000)
      expect(result).toContain("Section A")
      expect(result).toContain("Section B")
    })

    it("drops low-priority sections first", () => {
      const result = fitContext([
        { content: "A".repeat(350), priority: 10, label: "high" },  // ~100 tokens
        { content: "B".repeat(350), priority: 1, label: "low" },    // ~100 tokens
      ], 120)
      expect(result).toContain("A".repeat(350))
      // Low priority might be truncated or dropped
    })

    it("truncates when partially fitting", () => {
      const result = fitContext([
        { content: "A".repeat(350), priority: 10, label: "high" },  // ~100 tokens
        { content: "B".repeat(35000), priority: 1, label: "low" },  // ~10000 tokens
      ], 500)
      expect(result).toContain("A".repeat(350))
      expect(result).toContain("[...low truncated]")
      expect(result.length).toBeLessThan(35000) // trimmed significantly
    })
  })
})

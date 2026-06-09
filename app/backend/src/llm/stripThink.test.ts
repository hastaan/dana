// Unit tests for stripThink (⇄ server-py llm/think.py). Pure logic — no network/LLM.
import { describe, it, expect } from "bun:test"
import { stripThink } from "./stripThink"

describe("stripThink", () => {
  it("passes through text with no think tag", () => {
    expect(stripThink("just a normal answer")).toBe("just a normal answer")
  })

  it("passes through non-string values unchanged", () => {
    // @ts-expect-error — exercising the runtime guard
    expect(stripThink(null)).toBe(null)
    // @ts-expect-error — exercising the runtime guard
    expect(stripThink(42)).toBe(42)
  })

  it("removes a closed think block", () => {
    expect(stripThink("<think>reasoning here</think>The answer")).toBe("The answer")
  })

  it("removes a multiline closed block and leading whitespace", () => {
    expect(stripThink("<think>\nstep 1\nstep 2\n</think>\n\nFinal answer.")).toBe("Final answer.")
  })

  it("keeps the tail after an orphan close tag", () => {
    expect(stripThink("leaked reasoning</think>The real answer")).toBe("The real answer")
  })

  it("leaves an unclosed open tag's content intact", () => {
    const out = stripThink("<think>still thinking with no close")
    expect(out).toContain("still thinking with no close")
  })

  it("is case-insensitive", () => {
    expect(stripThink("<THINK>x</THINK>Y")).toBe("Y")
  })

  it("strips leading whitespace after removal", () => {
    expect(stripThink("<think>z</think>   \n  Answer")).toBe("Answer")
  })

  it("removes multiple closed blocks", () => {
    expect(stripThink("<think>a</think>One <think>b</think>Two")).toBe("One Two")
  })

  it("returns empty string unchanged", () => {
    expect(stripThink("")).toBe("")
  })
})

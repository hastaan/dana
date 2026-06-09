import { describe, it } from "bun:test"

// Skipped: this suite targeted runWeightCalculator() (replaced by runForumPrep with a different
// contract) and made live LLM calls (slow + non-deterministic, not runnable offline). It also
// asserted the old parties.json/representatives.json storage, now replaced by SQLite. Left as a
// skipped placeholder rather than asserting against the removed API.
describe.skip("WeightCalculator", () => {
  it("assigns weights and speaking budgets", () => {})
})

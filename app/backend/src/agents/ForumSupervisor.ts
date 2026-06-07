import { chatCompletionText } from "../llm/proxyClient"
import { budgetOutput } from "../llm/tokenBudget"
import { resolvePrompt } from "../llm/promptLoader"
import { runAgenticLoop } from "../llm/agenticLoop"
import { dbGetControls } from "../db/queries/settings"
import { log } from "../utils/logger"
import { emitThink } from "../routes/stream"
import { dbUpsertSupervisorState, dbGetSupervisorState } from "../db/queries/forum"
import { steeringBlock } from "../llm/steering"
import type { ForumTurn, ForumScenario, SupervisorState } from "../db/queries/forum"
import type { Representative } from "../db/queries/forum"

export const DEFAULT_MAX_TURNS = 50
export const COMPRESS_INTERVAL = 10    // compress history every N turns

export interface ModerateDecision {
  next_speaker: string | null
  reason: string
  directive: string | null
  should_close: boolean
  coverage_score: number
  closure_reason?: string
}

export class ForumSupervisor {
  private state: SupervisorState
  private topicId: string
  private model: string
  private topic: string
  private maxTurns: number
  private minTurns: number
  private checkInterval: number
  private compressInterval: number
  private partyRoster: string  // "id:name, id:name, ..." injected into scenario prompt

  constructor(
    topicId: string,
    sessionId: string,
    model: string,
    topic: string,
    maxTurns: number = DEFAULT_MAX_TURNS,
    minTurns: number = 8,
    representatives: Representative[] = [],
  ) {
    this.topicId = topicId
    this.model = model
    this.topic = topic
    this.partyRoster = representatives.map(r => `${r.party_id} = "${r.party_name}"`).join(", ")
    this.maxTurns = maxTurns
    this.minTurns = minTurns

    const controls = dbGetControls()
    this.checkInterval = controls.forum_scenario_update_interval
    this.compressInterval = controls.forum_compress_interval

    // Always start fresh — re-runs should not inherit old state
    this.state = {
      session_id: sessionId,
      topic_id: topicId,
      turn_count: 0,
      turn_distribution: {},
      live_scenarios: [],
      compressed_history: "",
      status: "running",
      updated_at: new Date().toISOString(),
    }
    this.persist()
  }

  get turnCount(): number { return this.state.turn_count }
  get liveScenarios(): ForumScenario[] { return this.state.live_scenarios }
  get compressedHistory(): string { return this.state.compressed_history }
  get turnDistribution(): Record<string, number> { return this.state.turn_distribution }
  get isDone(): boolean { return this.state.status === "done" }

  private recentSpeakers: string[] = []

  // Called after every turn — no LLM, pure bookkeeping
  observeTurn(turn: ForumTurn): void {
    this.state.turn_count++
    const partyId = turn.representative_id.replace("rep-", "")
    this.state.turn_distribution[partyId] = (this.state.turn_distribution[partyId] ?? 0) + 1
    this.recentSpeakers.push(partyId)
    if (this.recentSpeakers.length > 6) this.recentSpeakers.shift()
    this.state.updated_at = new Date().toISOString()
    this.persist()
  }

  private detectExchangeLoop(): { looping: boolean; parties: string[] } {
    if (this.recentSpeakers.length < 4) return { looping: false, parties: [] }
    const last4 = this.recentSpeakers.slice(-4)
    const unique = [...new Set(last4)]
    return { looping: unique.length <= 2, parties: unique }
  }

  private computeSilentParties(representatives: Representative[]): string[] {
    const silent: string[] = []
    for (const r of representatives) {
      const lastSpoke = this.recentSpeakers.lastIndexOf(r.party_id)
      const turnsSince = lastSpoke === -1
        ? this.state.turn_count
        : this.recentSpeakers.length - 1 - lastSpoke + Math.max(0, this.state.turn_count - this.recentSpeakers.length)
      if (turnsSince >= 8 && (this.state.turn_distribution[r.party_id] ?? 0) > 0) {
        silent.push(r.party_id)
      } else if ((this.state.turn_distribution[r.party_id] ?? 0) === 0 && this.state.turn_count >= 3) {
        silent.push(r.party_id)
      }
    }
    return silent
  }

  private computeBudgetWarning(): string {
    const softCeiling = Math.round(this.minTurns * 1.3)
    const hardRemaining = this.maxTurns - this.state.turn_count
    const softRemaining = softCeiling - this.state.turn_count

    if (hardRemaining <= 3) {
      return `FINAL TURNS: Only ${hardRemaining} turns before hard limit. The next speaker must deliver a closing synthesis.`
    }
    if (this.state.turn_count >= softCeiling) {
      return `OVER EXPECTED LENGTH: The debate has passed its expected ${softCeiling}-turn length. Close the debate unless there is a critical unresolved argument that no party has addressed.`
    }
    if (softRemaining <= 3 && softRemaining > 0) {
      return `WRAP-UP PHASE: ${softRemaining} turns until expected end at turn ${softCeiling}. Start directing parties toward their final positions and conclusions.`
    }
    return ""
  }

  // Moderate the next turn: pick speaker, issue directive, decide closure
  async moderate(lastTurn: ForumTurn | null, representatives: Representative[]): Promise<ModerateDecision> {
    // Hard ceiling check — no LLM needed
    if (this.state.turn_count >= this.maxTurns) {
      const reason = `Hard ceiling of ${this.maxTurns} turns reached`
      this.markDone(reason)
      return {
        next_speaker: null, reason, directive: null,
        should_close: true, coverage_score: 75, closure_reason: reason,
      }
    }

    // ── Hard guardrail: break two-party exchange loops ──────────────────
    const loop = this.detectExchangeLoop()
    if (loop.looping) {
      const fallback = this.deficitFallback(representatives.filter(r => !loop.parties.includes(r.party_id)))
      const [a, b] = loop.parties
      log.forum(`  Exchange limit: breaking ${a} vs ${b} loop — giving floor to ${fallback.party_id}`)
      emitThink(this.topicId, "⚖️", `Breaking exchange loop`, `${a} vs ${b} → ${fallback.party_id}`)
      return {
        next_speaker: fallback.party_id,
        reason: `Breaking ${a} vs ${b} exchange loop — other parties need the floor`,
        directive: `We've heard extensive exchange between the previous speakers. Let's hear a fresh perspective.`,
        should_close: false,
        coverage_score: Math.min(50, this.state.turn_count * 2),
      }
    }

    // ── Build template variables ────────────────────────────────────────
    const totalWeight = representatives.reduce((s, r) => s + r.speaking_weight, 0) || 1
    const softCeiling = Math.round(this.minTurns * 1.3)
    const partiesList = representatives
      .map(r => {
        const count = this.state.turn_distribution[r.party_id] ?? 0
        const share = r.speaking_weight / totalWeight
        const expectedTurns = Math.round(share * softCeiling)
        return `- ${r.party_id} (priority=${Math.round(share * 100)}%, turns=${count}/${expectedTurns})`
      })
      .join("\n")

    const turnDistribution = Object.entries(this.state.turn_distribution)
      .map(([id, count]) => `${id}: ${count} turns`)
      .join(", ")

    const recentSpeakersStr = this.recentSpeakers.length > 0
      ? this.recentSpeakers.slice(-4).join(" → ")
      : "None yet"

    const silentParties = this.computeSilentParties(representatives)
    const silentPartiesStr = silentParties.length > 0
      ? `SILENT PARTIES (haven't spoken in 8+ turns): ${silentParties.join(", ")}`
      : ""

    const budgetWarning = this.computeBudgetWarning()

    const scenariosSummary = this.state.live_scenarios.length > 0
      ? this.state.live_scenarios
          .map(s => `• ${s.title} (for: ${s.supported_by.join(", ")}, against: ${s.contested_by.join(", ")})`)
          .join("\n")
      : "No scenarios yet"

    let lastTurnStr: string
    if (lastTurn) {
      const cluesPart = lastTurn.clues_cited.length > 0 ? ` (cited: ${lastTurn.clues_cited.join(", ")})` : ""
      const full = `[${lastTurn.party_name}]: ${lastTurn.statement}${cluesPart}`
      lastTurnStr = full.length > 500 ? full.slice(0, 500) + "…" : full
    } else {
      lastTurnStr = "This is the first turn of the debate."
    }

    try {
      const promptConfig = await resolvePrompt("forum/supervisor-moderate", {
        topic: this.topic,
        parties_list: partiesList,
        turn_distribution: turnDistribution || "No turns yet",
        turn_number: String(this.state.turn_count + 1),
        soft_ceiling: String(softCeiling),
        hard_limit: String(this.maxTurns),
        min_turns: String(this.minTurns),
        recent_speakers: recentSpeakersStr,
        silent_parties: silentPartiesStr,
        budget_warning: budgetWarning,
        scenarios_summary: scenariosSummary,
        last_turn: lastTurnStr,
      })

      const effectiveModel = promptConfig.model ?? this.model
      const budget = budgetOutput(effectiveModel, promptConfig.content, { min: 200, max: 500 })

      const raw = await chatCompletionText({
        model: effectiveModel,
        messages: [
          { role: "system", content: promptConfig.content + steeringBlock(this.topicId, "debate") },
          { role: "user", content: "Moderate the next turn." },
        ],
        temperature: 0.3,
        max_tokens: budget,
      })

      const match = raw.match(/\{[\s\S]+\}/)
      if (!match) throw new Error("No JSON in moderate response")
      const decision = JSON.parse(match[0]) as ModerateDecision

      if (decision.should_close) {
        this.markDone(decision.closure_reason ?? decision.reason)
      }

      emitThink(this.topicId, "🎯", `Moderator → ${decision.next_speaker}`, decision.reason)

      return decision
    } catch (e) {
      log.forum(`  Supervisor moderate failed: ${e} — falling back to deficit-based pick`)

      // Deficit-based fallback: pick the rep with the fewest turns relative to weight
      const fallback = this.deficitFallback(representatives)
      const decision: ModerateDecision = {
        next_speaker: fallback.party_id,
        reason: "Fallback: deficit-based selection after moderate error",
        directive: null,
        should_close: false,
        coverage_score: 50,
      }

      emitThink(this.topicId, "🎯", `Moderator → ${decision.next_speaker}`, decision.reason)
      return decision
    }
  }

  // Pick representative with the largest deficit (fewest turns relative to weight)
  private deficitFallback(reps: Representative[]): Representative {
    const total = Math.max(this.state.turn_count, 1)
    let best = reps[0]
    let bestDeficit = -Infinity

    for (const r of reps) {
      const expectedShare = r.speaking_weight / 100
      const actualCount = this.state.turn_distribution[r.party_id] ?? 0
      const deficit = expectedShare - actualCount / total
      if (deficit > bestDeficit) {
        bestDeficit = deficit
        best = r
      }
    }

    return best
  }

  // Update scenario list from debate — every checkInterval turns
  async updateScenarios(allTurns: ForumTurn[]): Promise<ForumScenario[]> {
    if (allTurns.length === 0) return this.state.live_scenarios

    const turnsStr = allTurns
      .map(t => `[${t.party_name} T${t.round}]: ${t.statement.slice(0, 250)}`)
      .join("\n\n")

    const currentScenariosStr = JSON.stringify(this.state.live_scenarios, null, 2)

    const scenariosConfig = await resolvePrompt("forum/supervisor-scenarios", {
      topic: this.topic,
      current_scenarios: currentScenariosStr,
      all_turns: turnsStr,
      party_roster: this.partyRoster,
    })
    const effectiveModel = scenariosConfig.model ?? this.model

    const scenarioMax = Math.max(4000, this.state.live_scenarios.length * 700)
    const budget = budgetOutput(effectiveModel, scenariosConfig.content, { min: 1500, max: scenarioMax })

    try {
      let raw: string
      if (scenariosConfig.tools.length > 0) {
        raw = await runAgenticLoop({
          model: effectiveModel,
          topicId: this.topicId,
          stage: "forum",
          tools: scenariosConfig.tools,
          temperature: 0.2,
          max_tokens: budget,
          messages: [
            { role: "system", content: scenariosConfig.content },
            { role: "user", content: "Update the scenario list based on the debate so far." },
          ],
        })
      } else {
        raw = await chatCompletionText({
          model: effectiveModel,
          messages: [
            { role: "system", content: scenariosConfig.content },
            { role: "user", content: "Update the scenario list based on the debate so far." },
          ],
          temperature: 0.2,
          max_tokens: budget,
        })
      }

      const match = raw.match(/\[[\s\S]+\]/)
      if (!match) throw new Error("No JSON array in scenarios response")
      const updated = JSON.parse(match[0]) as ForumScenario[]
      this.state.live_scenarios = updated
      this.persist()
      log.forum(`  Supervisor: ${updated.length} scenarios tracked`)
      emitThink(this.topicId, "📊", `Scenarios updated`, `${updated.length} scenarios on the table`)
      return updated
    } catch (e) {
      log.forum(`  Supervisor scenario update failed: ${e}`)
      return this.state.live_scenarios
    }
  }

  // Compress conversation history — called every COMPRESS_INTERVAL turns
  async compressHistory(allTurns: ForumTurn[]): Promise<void> {
    if (allTurns.length < this.compressInterval) return

    // Compress all but the last 8 turns
    const toCompress = allTurns.slice(0, -8)
    if (toCompress.length === 0) return

    const turnsStr = toCompress
      .map(t => `[${t.party_name}]: ${t.statement.slice(0, 300)}`)
      .join("\n\n")

    try {
      const raw = await chatCompletionText({
        model: this.model,
        messages: [
          {
            role: "system",
            content: "You are summarizing a geopolitical debate transcript. Produce a dense, neutral summary that preserves: who argued what position, which clues were cited and how, which scenarios emerged, and any key concessions or disputes. Preserve clue IDs. Be comprehensive — this replaces the original transcript.",
          },
          { role: "user", content: `Summarize this debate transcript:\n\n${turnsStr}` },
        ],
        temperature: 0.2,
        max_tokens: 1500,
      })

      this.state.compressed_history = raw.trim()
      this.persist()
      log.forum(`  Supervisor: history compressed (${toCompress.length} turns → ${raw.length} chars)`)
    } catch (e) {
      log.forum(`  History compression failed: ${e}`)
    }
  }

  private markDone(reason: string): void {
    this.state.status = "done"
    this.state.closure_reason = reason
    this.state.updated_at = new Date().toISOString()
    this.persist()
  }

  private persist(): void {
    dbUpsertSupervisorState(this.topicId, this.state)
  }
}

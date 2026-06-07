import { log } from "../utils/logger"
import { budgetOutput } from "../llm/tokenBudget"
import { chatCompletionText } from "../llm/proxyClient"
import { dbGetControls } from "../db/queries/settings"
import { runForumPrepAgent } from "./ForumPrepAgent"
import { runRepresentativeTurn } from "./RepresentativeAgent"
import { ForumSupervisor, DEFAULT_MAX_TURNS, COMPRESS_INTERVAL } from "./ForumSupervisor"
import { writeArtifact } from "../tools/internal/artifactStore"
import { writeForumSession, getForumSession } from "../tools/internal/getForumData"
import { emit, emitThink } from "../routes/stream"
import { dbGetRepresentatives, dbGetAllScratchpads } from "../db/queries/forum"
import { dbUpsertForumSession } from "../db/queries/forum"
import type { ForumSession, ForumTurn, Representative } from "../db/queries/forum"

export interface ForumOrchestratorOutput {
  session_id: string
  turns_completed: number
  scenario_count: number
  closure_reason: string
}

function getDataDir() { return process.env.DATA_DIR || "/home/nima/dana/data" }

// Format a flat list of turns into display text for the session (grouped by every 10)
function turnBatch(turnNumber: number): number {
  return Math.floor((turnNumber - 1) / 10) + 1
}

export async function runForumOrchestrator(
  topicId: string,
  runId: string,
  sessionId: string,
  model: string,
  _checkpoint: unknown,
  onProgress?: (msg: string) => void,
  version?: number,
): Promise<ForumOrchestratorOutput> {
  const representatives = dbGetRepresentatives(topicId) as Representative[]
  if (!representatives.length) throw new Error("No representatives found")

  log.separator()
  log.forum(`Forum starting: ${representatives.length} parties, session=${sessionId}`)
  log.forum(`Parties: ${representatives.map(r => `${r.party_id}(w=${r.speaking_weight})`).join(", ")}`)
  log.separator()

  // ── Always start a fresh session ──────────────────────────────────────────
  const session: ForumSession = {
    session_id: sessionId,
    version: version ?? 1,
    type: "full",
    status: "running",
    started_at: new Date().toISOString(),
    rounds: [],
    scenarios: [],
  }
  await writeForumSession(topicId, session)
  log.forum("Starting fresh forum session")

  // Retrieve topic title from DB for supervisor/context
  const { dbGetTopic } = await import("../db/queries/topics")
  const topicRow = dbGetTopic(topicId)
  const topicTitle = topicRow?.title ?? topicId

  const controls = dbGetControls()
  const maxTurns = controls.forum_max_turns
  const multiplier = controls.forum_min_turns_multiplier
  const minTurns = Math.max(15, Math.floor(representatives.length * multiplier))

  // ── Phase 1: Preparation ─────────────────────────────────────────────────
  onProgress?.("Forum: agents preparing scratchpads…")
  emit(topicId, { type: "progress", stage: "forum", pct: 0.02, msg: "Representatives preparing…" })

  await runForumPrepAgent(topicId, topicTitle, sessionId, model, onProgress)
  emit(topicId, { type: "progress", stage: "forum", pct: 0.1, msg: "All representatives ready. Debate opening…" })

  // ── Phase 2: Moderated debate loop ────────────────────────────────────────
  const supervisor = new ForumSupervisor(topicId, sessionId, model, topicTitle, maxTurns, minTurns, representatives)
  const scenarioInterval = (controls as any).forum_scenario_update_interval ?? 5

  const allTurns: ForumTurn[] = session.rounds.flatMap(r => r.turns)
  let turnNumber = allTurns.length + 1
  let lastTurn: ForumTurn | null = allTurns.at(-1) ?? null

  log.forum(`Debate opening at turn ${turnNumber} (max=${maxTurns}, min=${minTurns})`)
  emitThink(topicId, "🎙️", "Forum is open", `${representatives.length} parties ready to debate`)

  while (!supervisor.isDone) {
    // Moderator decides who speaks next
    const decision = await supervisor.moderate(lastTurn, representatives)

    if (decision.should_close) {
      log.forum(`Debate closed by moderator at turn ${allTurns.length}: ${decision.closure_reason ?? decision.reason}`)
      emit(topicId, { type: "progress", stage: "forum", pct: 0.8, msg: `Moderator closed debate: ${decision.coverage_score}% coverage` })
      break
    }

    const selected = representatives.find(r => r.party_id === decision.next_speaker)
    if (!selected) {
      log.forum(`Moderator picked unknown party "${decision.next_speaker}", falling back to first rep`)
      break
    }

    onProgress?.(`Forum turn ${turnNumber}: ${selected.party_id}`)

    const myTurnCount = supervisor.turnDistribution[selected.party_id] ?? 0

    const { turn, passed } = await runRepresentativeTurn({
      topicId,
      runId,
      sessionId,
      partyId: selected.party_id,
      personaTitle: selected.persona_title,
      model,
      turnNumber,
      myTurnCount,
      speakingWeight: selected.speaking_weight,
      recentTurns: allTurns.slice(-6),
      compressedHistory: supervisor.compressedHistory,
      liveScenarios: supervisor.liveScenarios,
      topic: topicTitle,
      moderatorDirective: decision.directive ?? undefined,
    })

    if (passed) {
      log.forum(`  ${selected.party_id} passed turn ${turnNumber}`)
    } else if (turn) {
      if (decision.directive) turn.moderator_directive = decision.directive
      if (decision.reason) turn.moderator_reason = decision.reason
      allTurns.push(turn)
      lastTurn = turn

      const batchNum = turnBatch(turnNumber)
      let roundEntry = session.rounds.find(r => r.round === batchNum)
      if (!roundEntry) {
        roundEntry = { round: batchNum, type: "debate", turns: [] }
        session.rounds.push(roundEntry)
      }
      roundEntry.turns.push(turn)
      await writeForumSession(topicId, session)

      emit(topicId, { type: "forum_turn", turn: turn as unknown as Record<string, unknown> })
      supervisor.observeTurn(turn)
      turnNumber++

      // Periodic full scenario update
      if (allTurns.length % scenarioInterval === 0) {
        const scenarios = await supervisor.updateScenarios(allTurns)
        session.scenarios = scenarios
        await writeForumSession(topicId, session)
        emit(topicId, { type: "progress", stage: "forum", pct: Math.min(0.1 + (allTurns.length / maxTurns) * 0.7, 0.8), msg: `Turn ${allTurns.length}: ${decision.coverage_score}% coverage` })
      }

      // Periodic history compression
      if (allTurns.length % COMPRESS_INTERVAL === 0) {
        await supervisor.compressHistory(allTurns)
      }
    }
  }

  log.forum(`Debate ended after ${allTurns.length} turns`)

  // ── Phase 3: Final scenario update ────────────────────────────────────────
  emit(topicId, { type: "progress", stage: "forum", pct: 0.85, msg: "Finalizing scenarios…" })
  const finalScenarios = await supervisor.updateScenarios(allTurns)
  session.scenarios = finalScenarios
  if (finalScenarios.length > 0) {
    const sorted = [...finalScenarios].sort((a, b) => b.supported_by.length - a.supported_by.length)
    session.scenarios = sorted
    await writeForumSession(topicId, session)
  }

  emit(topicId, { type: "progress", stage: "forum", pct: 0.9, msg: "Synthesizing debate summary…" })

  // ── Phase 4: Debate summary for expert council ────────────────────────────
  const allScratchpads = dbGetAllScratchpads(topicId, sessionId)
  const debateSummary = await synthesizeDebate(topicTitle, allTurns, finalScenarios, model)

  // ── Phase 5: Finalize session ─────────────────────────────────────────────
  const contestedClues = computeContestedClues(allTurns)
  const uncontestedClues = computeUncontestedClues(allTurns, contestedClues)

  session.scenario_summary = {
    scenarios: finalScenarios.map(s => ({
      id: s.id,
      title: s.title,
      key_clues: s.clues_cited,
      required_conditions: s.required_conditions,
      falsification_conditions: s.falsification_conditions,
    })),
    contested_clues: contestedClues,
    uncontested_clues: uncontestedClues,
  }
  session.debate_summary = debateSummary
  session.status = "complete"
  session.completed_at = new Date().toISOString()
  await writeForumSession(topicId, session)

  const output: ForumOrchestratorOutput = {
    session_id: sessionId,
    turns_completed: allTurns.length,
    scenario_count: finalScenarios.length,
    closure_reason: supervisor.isDone ? "supervisor" : "max_turns",
  }

  await writeArtifact(topicId, runId, "forum_orchestrator", {
    ...output,
    debate_summary: debateSummary,
    scratchpads: allScratchpads.map(s => ({ party_id: s.party_id, content: s.content })),
  })

  emit(topicId, { type: "stage_complete", stage: "forum", session_id: sessionId })
  log.forum(`Forum complete: ${allTurns.length} turns, ${finalScenarios.length} scenarios`)

  return output
}

async function synthesizeDebate(
  topic: string,
  allTurns: ForumTurn[],
  scenarios: { title: string; description: string; supported_by: string[]; contested_by: string[] }[],
  model: string
): Promise<string> {
  const turnsStr = allTurns
    .map(t => `[${t.party_name}]: ${t.statement.slice(0, 200)}`)
    .join("\n\n")

  const scenariosStr = scenarios
    .map(s => `• ${s.title}: ${s.description} (for: ${s.supported_by.join(", ")}, against: ${s.contested_by.join(", ")})`)
    .join("\n")

  try {
    return await chatCompletionText({
      model,
      messages: [
        {
          role: "system",
          content: "You are summarizing a multi-party geopolitical forum debate for expert analysts. Produce a 4-6 paragraph dense summary covering: the main positions argued, key clues cited and disputed, how scenarios emerged from the debate, and where parties found unexpected common ground or irreconcilable disagreement. Preserve clue IDs inline.",
        },
        {
          role: "user",
          content: `TOPIC: ${topic}\n\nSCENARIOS THAT EMERGED:\n${scenariosStr}\n\nDEBATE TRANSCRIPT (truncated):\n${turnsStr.slice(0, 12000)}`,
        },
      ],
      temperature: 0.3,
      max_tokens: budgetOutput(model, turnsStr.slice(0, 12000) + scenariosStr, { min: 800, max: 2000 }),
    })
  } catch {
    return "Debate summary unavailable."
  }
}

function computeContestedClues(turns: ForumTurn[]) {
  const clueRepMap = new Map<string, Set<string>>()
  for (const t of turns) {
    for (const cid of t.clues_cited) {
      if (!clueRepMap.has(cid)) clueRepMap.set(cid, new Set())
      clueRepMap.get(cid)!.add(t.representative_id)
    }
  }
  const contested: { clue_id: string; cited_by: string[]; conflict: string }[] = []
  for (const [clueId, reps] of clueRepMap.entries()) {
    if (reps.size >= 2) {
      contested.push({
        clue_id: clueId,
        cited_by: [...reps],
        conflict: `Cited by ${reps.size} different parties with potentially conflicting interpretations`,
      })
    }
  }
  return contested
}

function computeUncontestedClues(turns: ForumTurn[], contested: { clue_id: string }[]) {
  const contestedIds = new Set(contested.map(c => c.clue_id))
  const allCited = new Set(turns.flatMap(t => t.clues_cited))
  return [...allCited].filter(id => !contestedIds.has(id))
}

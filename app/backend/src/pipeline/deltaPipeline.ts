import { computeDelta, createVersion, getLatestVersion } from "./stateManager"
import { runDeltaRepresentativeAgent, type DeltaContext } from "../agents/DeltaRepresentativeAgent"
import { runScenarioScorer } from "../agents/ScenarioScorer"
import { writeForumSession, type ForumSession } from "../tools/internal/getForumData"
import { readArtifact, writeArtifact } from "../tools/internal/artifactStore"
import { chatCompletionText } from "../llm/proxyClient"
import { runAgenticLoop } from "../llm/agenticLoop"
import { resolvePrompt } from "../llm/promptLoader"
import { writeCheckpoint } from "./checkpointManager"
import { emit } from "../routes/stream"
import { getTopic, updateTopic } from "./topicManager"
import { dbGetRepresentatives } from "../db/queries/forum"

import type { Topic } from "./topicManager"
import type { DeltaTurn } from "../agents/DeltaRepresentativeAgent"

async function loadTopic(topicId: string): Promise<Topic> {
  return getTopic(topicId)
}

async function updateTopicStatus(topicId: string, status: Topic["status"]) {
  await updateTopic(topicId, { status })
}

export async function runDeltaPipeline(topicId: string, runId?: string): Promise<{ run_id: string; status: string }> {
  runId = runId ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const topic = await loadTopic(topicId)

  try {
    // Step 1: Compute clue delta
    emit(topicId, { type: "progress", stage: "delta", pct: 0, msg: "Computing clue delta..." })
    const latestState = await getLatestVersion(topicId)
    if (!latestState) throw new Error("No prior state found")

    const delta = await computeDelta(topicId)
    if (!delta) throw new Error("No changes detected")

    const deltaContext: DeltaContext = {
      new_clues: delta.new_clues,
      updated_clues: delta.updated_clues,
      affected_parties: delta.affected_parties,
      change_narrative: delta.key_change,
    }

    const priorSessionId = latestState.forum_session_id ?? "forum-session-v1"
    const newVersion = latestState.version + 1
    const newSessionId = `forum-session-v${newVersion}`

    // Step 2: Delta forum session
    await updateTopicStatus(topicId, "forum")
    emit(topicId, { type: "progress", stage: "forum", pct: 0, msg: "Running delta forum..." })

    // Load representatives
    const reps = dbGetRepresentatives(topicId)

    const deltaTurns: DeltaTurn[] = []
    for (const rep of reps) {
      const turn = await runDeltaRepresentativeAgent(
        topicId, runId, rep.party_id, priorSessionId, deltaContext,
        topic.models.delta_updates,
        (msg) => emit(topicId, { type: "progress", stage: "forum", pct: 0.5, msg })
      )
      deltaTurns.push(turn)
      emit(topicId, { type: "forum_turn", turn: turn as unknown as Record<string, unknown> })
    }

    // Synthesize scenario updates from delta turns
    emit(topicId, { type: "progress", stage: "forum", pct: 0.8, msg: "Synthesizing scenario updates..." })

    const scenarioUpdatePrompt = `Given these position updates from representatives, determine how each scenario is affected.

DELTA CONTEXT: ${deltaContext.change_narrative}

POSITION UPDATES:
${deltaTurns.map(t => `${t.party_name}: ${t.position_delta} — ${t.updated_position.slice(0, 300)}`).join("\n\n")}

Output JSON array:
[{ "scenario_id": "<id>", "update_type": "strengthened" | "weakened" | "unchanged" | "new", "reason": "<brief reason>" }]`

    const impactConfig = await resolvePrompt("forum/delta-scenario-impact")
    const impactModel = impactConfig.model ?? topic.models.delta_updates

    let scenarioUpdates: { scenario_id: string; update_type: string; reason: string }[] = []
    try {
      let raw: string
      if (impactConfig.tools.length > 0) {
        raw = await runAgenticLoop({
          model: impactModel,
          messages: [
            { role: "system", content: impactConfig.content },
            { role: "user", content: scenarioUpdatePrompt },
          ],
          tools: impactConfig.tools,
          topicId,
          stage: "delta",
          temperature: 0.3,
          max_tokens: 1000,
        })
      } else {
        raw = await chatCompletionText({
          model: impactModel,
          messages: [
            { role: "system", content: impactConfig.content },
            { role: "user", content: scenarioUpdatePrompt },
          ],
          temperature: 0.3,
          max_tokens: 1000,
        })
      }
      const match = raw.match(/\[[\s\S]+\]/)
      if (match) scenarioUpdates = JSON.parse(match[0])
    } catch (e) {
      console.warn("Scenario update synthesis failed:", e)
    }

    // Write delta forum session
    const deltaSession: ForumSession = {
      session_id: newSessionId,
      version: newVersion,
      type: "delta",
      status: "complete",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      rounds: [{
        round: 1,
        type: "position_updates",
        turns: deltaTurns.map(t => ({
          id: t.id,
          representative_id: t.representative_id,
          party_name: t.party_name,
          statement: `PRIOR: ${t.prior_position_summary}\n\nUPDATED: ${t.updated_position}\n\nDELTA: ${t.position_delta}`,
          clues_cited: t.clues_cited,
          timestamp: t.timestamp,
          round: 1,
          type: "position_update",
          word_count: t.word_count,
        })),
      }],
      scenarios: [],
      scenario_summary: {
        scenarios: [],
        contested_clues: [],
        uncontested_clues: [],
      },
    }
    await writeForumSession(topicId, deltaSession)
    await writeArtifact(topicId, runId, "delta_forum_orchestrator", { scenario_updates: scenarioUpdates })
    emit(topicId, { type: "stage_complete", stage: "forum" })

    // Step 3: Scenario Scoring (using prior session which has full scenario data)
    await updateTopicStatus(topicId, "expert_council")
    emit(topicId, { type: "progress", stage: "expert_council", pct: 0, msg: "Scoring updated scenarios..." })

    const councilOutput = await runScenarioScorer(
      topicId, runId, priorSessionId, topic.models.delta_updates,
      (msg) => emit(topicId, { type: "progress", stage: "expert_council", pct: 0.5, msg })
    )

    // Create new state version
    await createVersion(topicId, {
      label: `Delta update: ${deltaContext.change_narrative.slice(0, 80)}`,
      trigger: "user_manual",
      forum_session_id: newSessionId,
      verdict_id: `verdict-v${newVersion}`,
      delta_from: latestState.version,
      delta_summary: delta,
    })

    await updateTopicStatus(topicId, "complete")
    emit(topicId, { type: "stage_complete", stage: "verdict" })

    return { run_id: runId, status: "complete" }
  } catch (e) {
    console.error("Delta pipeline failed:", e)
    emit(topicId, { type: "error", message: String(e) })
    return { run_id: runId, status: `error: ${e}` }
  }
}

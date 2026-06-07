import { mkdir } from "fs/promises"
import { join } from "path"
import { log } from "../utils/logger"
import { runDiscoveryAgent } from "../agents/DiscoveryAgent"
import { runEnrichmentAgent } from "../agents/EnrichmentAgent"
import { runForumPrep } from "../agents/WeightCalculator"
import { runForumOrchestrator } from "../agents/ForumOrchestrator"
import { runScenarioScorer } from "../agents/ScenarioScorer"
import { writeCheckpoint, readCheckpoint, isStageComplete } from "./checkpointManager"
import { getOrAllocateVersion, allocateVersion, finalizeVersion, setVersionSessionId, markStageComplete } from "./stateManager"

import { emit } from "../routes/stream"
import { getTopic, updateTopic } from "./topicManager"
import { dbGetParties } from "../db/queries/parties"
import { dbGetLatestCompleteState } from "../db/queries/states"
import type { Topic } from "./topicManager"

function getDataDir() { return process.env.DATA_DIR || "/home/nima/dana/data" }

async function updateTopicStatus(topicId: string, status: Topic["status"]) {
  await updateTopic(topicId, { status })
}

async function loadTopic(topicId: string): Promise<Topic> {
  return getTopic(topicId)
}


// Stage 1 only: Discovery → review_parties
export async function runDiscoverStage(topicId: string, version?: number): Promise<{ status: string; version: number }> {
  const topic = await loadTopic(topicId)
  const v = version ?? await getOrAllocateVersion(topicId, { forkStage: "discovery" })
  const runId = `run-v${v}`

  log.separator()
  log.pipeline(`Starting DISCOVERY for "${topic.title}"`, `run=${runId}, version=${v}`)
  log.separator()

  try {
    await updateTopicStatus(topicId, "discovery")
    emit(topicId, { type: "progress", stage: "discovery", pct: 0, msg: "Starting discovery..." })

    await runDiscoveryAgent(
      topicId, topic.title, topic.description,
      topic.models.enrichment, runId,
      (msg) => emit(topicId, { type: "progress", stage: "discovery", pct: 0.5, msg })
    )

    await writeCheckpoint(topicId, runId, { stage: "enrichment", step: 0 })
    await markStageComplete(topicId, v, "discovery")
    await updateTopicStatus(topicId, "review_parties")

    log.discovery("Discovery complete — awaiting user review of parties")
    emit(topicId, { type: "stage_complete", stage: "discovery" })

    return { status: "review_parties", version: v }
  } catch (e) {
    log.error("DISCOVERY", "Discovery failed", e)
    emit(topicId, { type: "error", message: String(e) })
    return { status: `error: ${e}`, version: v }
  }
}

// Stage 2 only: Enrichment → review_enrichment
export async function runEnrichStage(topicId: string, version?: number): Promise<{ status: string; version: number }> {
  const topic = await loadTopic(topicId)
  const v = version ?? await getOrAllocateVersion(topicId, { forkStage: "enrichment" })
  const runId = `run-v${v}`

  log.separator()
  log.pipeline(`Starting ENRICHMENT for "${topic.title}"`, `run=${runId}, version=${v}`)
  log.separator()

  try {
    await updateTopicStatus(topicId, "enrichment")
    emit(topicId, { type: "progress", stage: "enrichment", pct: 0, msg: "Starting enrichment..." })

    await runEnrichmentAgent(
      topicId, topic.title, topic.description,
      { enrichment: topic.models.enrichment, extraction: topic.models.extraction },
      runId,
      (msg) => emit(topicId, { type: "progress", stage: "enrichment", pct: 0.5, msg })
    )

    await writeCheckpoint(topicId, runId, { stage: "weight", step: 0 })
    await markStageComplete(topicId, v, "enrichment")
    await updateTopicStatus(topicId, "review_enrichment")

    log.enrichment("Enrichment complete — awaiting user review of clues")
    emit(topicId, { type: "stage_complete", stage: "enrichment" })

    return { status: "review_enrichment", version: v }
  } catch (e) {
    log.error("ENRICHMENT", "Enrichment failed", e)
    emit(topicId, { type: "error", message: String(e) })
    return { status: `error: ${e}`, version: v }
  }
}

// Stage 3 only: Forum Prep → review_forum_prep
export async function runForumPrepStage(topicId: string, version?: number): Promise<{ status: string; version: number }> {
  const topic = await loadTopic(topicId)
  const v = version ?? await getOrAllocateVersion(topicId, { forkStage: "forum_prep" })
  const runId = `run-v${v}`

  log.separator()
  log.pipeline(`Starting FORUM PREP for "${topic.title}"`, `run=${runId}, version=${v}`)
  log.separator()

  try {
    await updateTopicStatus(topicId, "forum_prep")
    emit(topicId, { type: "progress", stage: "forum_prep", pct: 0, msg: "Generating forum representatives..." })

    await runForumPrep(
      topicId, topic.title, topic.models.enrichment, runId,
      (msg) => emit(topicId, { type: "progress", stage: "forum_prep", pct: 0.5, msg })
    )

    try {
      const parties = dbGetParties(topicId)
      emit(topicId, { type: "weight_result", parties: parties.map(p => ({ name: p.name, weight: p.weight })) })
    } catch { /* non-fatal */ }

    await writeCheckpoint(topicId, runId, { stage: "forum", step: 0 })
    await markStageComplete(topicId, v, "forum_prep")
    await updateTopicStatus(topicId, "review_forum_prep")

    log.weight("Forum Prep complete — awaiting user review of representatives")
    emit(topicId, { type: "stage_complete", stage: "forum_prep" })

    return { status: "review_forum_prep", version: v }
  } catch (e) {
    log.error("FORUM_PREP", "Forum Prep failed", e)
    await updateTopicStatus(topicId, "review_enrichment")
    emit(topicId, { type: "error", message: String(e) })
    return { status: `error: ${e}`, version: v }
  }
}

// Stage 4 only: Forum → review_forum
export async function runForumStage(topicId: string, version?: number): Promise<{ status: string; version: number }> {
  const topic = await loadTopic(topicId)
  const v = version ?? await getOrAllocateVersion(topicId, { forkStage: "forum" })
  const runId = `run-v${v}`
  const sessionId = `forum-session-v${v}`

  log.separator()
  log.pipeline(`Starting FORUM for "${topic.title}"`, `run=${runId}, version=${v}, session=${sessionId}`)
  log.separator()

  try {
    await updateTopicStatus(topicId, "forum")
    emit(topicId, { type: "progress", stage: "forum", pct: 0, msg: "Starting forum..." })

    await runForumOrchestrator(
      topicId, runId, sessionId, topic.models.forum_reasoning, null,
      (msg) => emit(topicId, { type: "progress", stage: "forum", pct: 0.5, msg }),
      v,
    )

    await setVersionSessionId(topicId, v, sessionId)
    await markStageComplete(topicId, v, "forum")
    await writeCheckpoint(topicId, runId, { stage: "expert_council", step: 0 })
    await updateTopicStatus(topicId, "review_forum")

    log.forum("Forum complete — awaiting user review")
    emit(topicId, { type: "stage_complete", stage: "forum" })

    return { status: "review_forum", version: v }
  } catch (e) {
    log.error("FORUM", "Forum failed", e)
    await updateTopicStatus(topicId, "review_forum_prep")
    emit(topicId, { type: "error", message: String(e) })
    return { status: `error: ${e}`, version: v }
  }
}

// Stage 5 only: Scoring → complete
export async function runScoringStage(topicId: string, version?: number): Promise<{ status: string; version: number }> {
  const topic = await loadTopic(topicId)

  // For scoring, reuse the current version (don't fork — it continues the current pipeline)
  const v = version ?? topic.current_version
  const runId = `run-v${v}`
  const sessionId = `forum-session-v${v}`

  log.separator()
  log.pipeline(`Starting SCORING for "${topic.title}"`, `run=${runId}, version=${v}`)
  log.separator()

  try {
    await updateTopicStatus(topicId, "expert_council")
    emit(topicId, { type: "progress", stage: "expert_council", pct: 0, msg: "Scoring scenarios..." })

    const councilOutput = await runScenarioScorer(
      topicId, runId, sessionId, topic.models.expert_council,
      (msg) => emit(topicId, { type: "progress", stage: "expert_council", pct: 0.5, msg }),
      v,
    )

    await finalizeVersion(topicId, v, {
      forum_session_id: sessionId,
      verdict_id: councilOutput.verdict_id,
    })

    emit(topicId, { type: "stage_complete", stage: "verdict" })
    log.expert("Scoring complete")

    return { status: "complete", version: v }
  } catch (e) {
    log.error("SCORING", "Scoring failed", e)
    await updateTopicStatus(topicId, "review_forum")
    emit(topicId, { type: "error", message: String(e) })
    return { status: `error: ${e}`, version: v }
  }
}

// Stages 3-5: ForumPrep → Forum → Scoring (autonomous)
export async function runAnalyzeStages(topicId: string): Promise<{ run_id: string; status: string }> {
  const topic = await loadTopic(topicId)
  const v = await getOrAllocateVersion(topicId, { forkStage: "forum_prep" })
  const runId = `run-v${v}`
  const checkpoint = await readCheckpoint(topicId, runId)
  const sessionId = `forum-session-v${v}`

  log.separator()
  log.pipeline(`Starting ANALYSIS (forumPrep→forum→scoring) for "${topic.title}"`, `run=${runId}, version=${v}`)
  log.separator()
  const pipelineStart = Date.now()

  try {
    // Stage 3: Forum Prep
    if (!isStageComplete(checkpoint, "forum_prep") && !isStageComplete(checkpoint, "weight")) {
      log.weight("Stage 3/5: FORUM PREP starting")
      emit(topicId, { type: "progress", stage: "forum_prep", pct: 0, msg: "Generating forum representatives..." })

      await runForumPrep(
        topicId, topic.title, topic.models.enrichment, runId,
        (msg) => emit(topicId, { type: "progress", stage: "forum_prep", pct: 0.5, msg })
      )

      try {
        const parties = dbGetParties(topicId)
        emit(topicId, { type: "weight_result", parties: parties.map(p => ({ name: p.name, weight: p.weight })) })
      } catch { /* non-fatal */ }

      await writeCheckpoint(topicId, runId, { stage: "forum", step: 0 })
      await markStageComplete(topicId, v, "forum_prep")
      log.weight("Stage 3/5: FORUM PREP complete")
      emit(topicId, { type: "stage_complete", stage: "forum_prep" })
    } else { log.weight("Stage 3/5: FORUM PREP skipped (checkpoint)") }

    // Stage 4: Forum
    if (!isStageComplete(checkpoint, "forum")) {
      await updateTopicStatus(topicId, "forum")
      log.forum("Stage 4/5: FORUM starting")
      emit(topicId, { type: "progress", stage: "forum", pct: 0, msg: "Starting forum..." })

      await runForumOrchestrator(
        topicId, runId, sessionId, topic.models.forum_reasoning, null,
        (msg) => emit(topicId, { type: "progress", stage: "forum", pct: 0.5, msg }),
        v,
      )

      await setVersionSessionId(topicId, v, sessionId)
      await markStageComplete(topicId, v, "forum")
      await writeCheckpoint(topicId, runId, { stage: "expert_council", step: 0 })
      log.forum("Stage 4/5: FORUM complete")
    } else { log.forum("Stage 4/5: FORUM skipped (checkpoint)") }

    // Stage 5: Scenario Scoring
    await updateTopicStatus(topicId, "expert_council")
    log.expert("Stage 5/5: SCENARIO SCORER starting")
    emit(topicId, { type: "progress", stage: "expert_council", pct: 0, msg: "Scoring scenarios..." })

    const councilOutput = await runScenarioScorer(
      topicId, runId, sessionId, topic.models.expert_council,
      (msg) => emit(topicId, { type: "progress", stage: "expert_council", pct: 0.5, msg }),
      v,
    )

    await finalizeVersion(topicId, v, {
      forum_session_id: sessionId,
      verdict_id: councilOutput.verdict_id,
    })

    emit(topicId, { type: "stage_complete", stage: "verdict" })

    const totalElapsed = Math.round((Date.now() - pipelineStart) / 1000)
    log.separator()
    log.pipeline(`Analysis COMPLETE in ${totalElapsed}s`, `run=${runId}, version=${v}`)
    log.separator()

    return { run_id: runId, status: "complete" }
  } catch (e) {
    log.error("PIPELINE", "Analysis FAILED", e)
    await updateTopicStatus(topicId, "review_enrichment")
    emit(topicId, { type: "error", message: String(e) })
    return { run_id: runId, status: `error: ${e}` }
  }
}

// Clean re-analysis: fresh ForumPrep → Forum → Scoring
export async function runReanalysis(topicId: string): Promise<{ run_id: string; status: string }> {
  const topic = await loadTopic(topicId)
  const latestComplete = dbGetLatestCompleteState(topicId)
  const v = await allocateVersion(topicId, { forkFrom: latestComplete?.version ?? null, forkStage: "forum_prep", trigger: "user_manual" })
  const runId = `reanalysis-v${v}`
  const sessionId = `forum-session-v${v}`

  log.separator()
  log.pipeline(`Starting CLEAN RE-ANALYSIS for "${topic.title}"`, `run=${runId}, version=${v}, session=${sessionId}`)
  log.separator()

  const checkpointDir = join(getDataDir(), "topics", topicId, "logs", `run-${runId}`)
  await mkdir(checkpointDir, { recursive: true })

  const pipelineStart = Date.now()

  try {
    // Stage 3: Forum Prep (fresh)
    log.weight("Stage 3/5: FORUM PREP starting (fresh)")
    emit(topicId, { type: "progress", stage: "forum_prep", pct: 0, msg: "Generating forum representatives..." })

    await runForumPrep(
      topicId, topic.title, topic.models.enrichment, runId,
      (msg) => emit(topicId, { type: "progress", stage: "forum_prep", pct: 0.5, msg })
    )

    try {
      const parties = dbGetParties(topicId)
      emit(topicId, { type: "weight_result", parties: parties.map(p => ({ name: p.name, weight: p.weight })) })
    } catch { /* non-fatal */ }

    await markStageComplete(topicId, v, "forum_prep")
    log.weight("Stage 3/5: FORUM PREP complete")
    emit(topicId, { type: "stage_complete", stage: "forum_prep" })

    // Stage 4: Forum (fresh)
    await updateTopicStatus(topicId, "forum")
    log.forum("Stage 4/5: FORUM starting (fresh)")
    emit(topicId, { type: "progress", stage: "forum", pct: 0, msg: "Starting fresh forum..." })

    await runForumOrchestrator(
      topicId, runId, sessionId, topic.models.forum_reasoning, null,
      (msg) => emit(topicId, { type: "progress", stage: "forum", pct: 0.5, msg }),
      v,
    )

    await setVersionSessionId(topicId, v, sessionId)
    await markStageComplete(topicId, v, "forum")
    log.forum("Stage 4/5: FORUM complete")

    // Stage 5: Scoring
    await updateTopicStatus(topicId, "expert_council")
    log.expert("Stage 5/5: SCENARIO SCORER starting (fresh)")
    emit(topicId, { type: "progress", stage: "expert_council", pct: 0, msg: "Scoring scenarios..." })

    const councilOutput = await runScenarioScorer(
      topicId, runId, sessionId, topic.models.expert_council,
      (msg) => emit(topicId, { type: "progress", stage: "expert_council", pct: 0.5, msg }),
      v,
    )

    await finalizeVersion(topicId, v, {
      forum_session_id: sessionId,
      verdict_id: councilOutput.verdict_id,
    })

    emit(topicId, { type: "stage_complete", stage: "verdict" })

    const totalElapsed = Math.round((Date.now() - pipelineStart) / 1000)
    log.separator()
    log.pipeline(`Re-analysis COMPLETE in ${totalElapsed}s`, `run=${runId}, version=${v}`)
    log.separator()

    return { run_id: runId, status: "complete" }
  } catch (e) {
    log.error("PIPELINE", "Re-analysis FAILED", e)
    await updateTopicStatus(topicId, "stale")
    emit(topicId, { type: "error", message: String(e) })
    return { run_id: runId, status: `error: ${e}` }
  }
}

import { dbGetAllStates, dbGetLatestState, dbGetLatestCompleteState, dbGetState, dbInsertState, dbFinalizeVersion, dbUpdateVersionField, dbUpdateCompletedStages } from "../db/queries/states"
import { dbGetClues } from "../db/queries/clues"
import { dbGetParties } from "../db/queries/parties"
import { dbGetRepresentatives } from "../db/queries/forum"
import { dbUpdateTopic } from "../db/queries/topics"
import { log } from "../utils/logger"

const STAGE_ORDER = ["discovery", "enrichment", "forum_prep", "forum", "expert_council"]

export type { KnowledgeState, ClueSnapshot, DeltaSummary } from "../db/queries/states"

export async function getCurrentClueSnapshot(topicId: string) {
  const clues = dbGetClues(topicId)
  const ids_and_versions: Record<string, number> = {}
  for (const clue of clues) ids_and_versions[clue.id] = clue.current
  return { count: clues.length, ids_and_versions }
}

export async function getLatestVersion(topicId: string) {
  return dbGetLatestState(topicId)
}

export async function getVersion(topicId: string, version: number) {
  return dbGetState(topicId, version)
}

export async function getAllVersions(topicId: string) {
  return dbGetAllStates(topicId)
}

// Reuse current in-progress version or allocate a new one.
// For sequential first-run stages (discover → enrich → ... → scoring), reuses the same version.
// Only allocates a new version when forking from a completed version (re-run).
export async function getOrAllocateVersion(
  topicId: string,
  opts: {
    forkStage: string | null
    trigger?: "initial_run" | "user_manual"
  }
): Promise<number> {
  const latest = dbGetLatestState(topicId)

  // If there's an in-progress version, reuse it
  if (latest && latest.version_status === "in_progress") {
    log.pipeline(`Reusing in-progress version ${latest.version}`)
    return latest.version
  }

  // Otherwise allocate a new version, forking from the latest complete version if any
  const forkFrom = latest?.version_status === "complete" ? latest.version : null
  return allocateVersion(topicId, { forkFrom, forkStage: opts.forkStage, trigger: opts.trigger })
}

// Allocate a new version number upfront before any stage runs.
// If forking from an existing version, snapshots parties/reps from the current state.
export async function allocateVersion(
  topicId: string,
  opts: {
    forkFrom: number | null
    forkStage: string | null
    label?: string
    trigger?: "initial_run" | "user_manual"
  }
): Promise<number> {
  const states = dbGetAllStates(topicId)
  const version = states.length > 0 ? Math.max(...states.map(s => s.version)) + 1 : 1

  const clueSnapshot = await getCurrentClueSnapshot(topicId)

  // Snapshot current parties and representatives
  const parties = dbGetParties(topicId)
  const reps = dbGetRepresentatives(topicId)
  const partiesSnapshot = JSON.stringify(parties)
  const representativesSnapshot = JSON.stringify(reps)

  // Only copy forum_session_id from parent if forking AFTER forum (e.g., at scoring).
  // If forking at discovery/enrichment/forum_prep/forum, the new version needs its own forum.
  const stagesAfterForum = ["expert_council", "scoring"]
  let parentSessionId: string | null = null
  if (opts.forkFrom && opts.forkStage && stagesAfterForum.includes(opts.forkStage)) {
    const parentState = dbGetState(topicId, opts.forkFrom)
    if (parentState) {
      parentSessionId = parentState.forum_session_id
    }
  }

  // Inherit completed_stages from parent, truncated to stages before the fork point
  let inheritedStages: string[] = []
  if (opts.forkFrom && opts.forkStage) {
    const parentState = dbGetState(topicId, opts.forkFrom)
    if (parentState) {
      const forkIndex = STAGE_ORDER.indexOf(opts.forkStage)
      if (forkIndex >= 0) {
        inheritedStages = parentState.completed_stages.filter(s => STAGE_ORDER.indexOf(s) < forkIndex)
      }
    }
  }

  const state = {
    version,
    label: opts.label ?? (opts.forkFrom ? `Re-run from ${opts.forkStage} (v${version})` : `Analysis v${version}`),
    created_at: new Date().toISOString(),
    trigger: opts.trigger ?? (opts.forkFrom ? "user_manual" as const : "initial_run" as const),
    clue_snapshot: clueSnapshot,
    forum_session_id: parentSessionId,
    verdict_id: null,
    delta_from: opts.forkFrom,
    delta_summary: null,
    parent_version: opts.forkFrom,
    fork_stage: opts.forkStage,
    version_status: "in_progress" as const,
    parties_snapshot: partiesSnapshot,
    representatives_snapshot: representativesSnapshot,
    completed_stages: inheritedStages,
  }

  dbInsertState(topicId, state)
  dbUpdateTopic(topicId, { current_version: version })

  log.pipeline(`Allocated version ${version}` + (opts.forkFrom ? ` (forked from v${opts.forkFrom} at ${opts.forkStage})` : ""))

  return version
}

// Called at the end of scoring to mark a version complete.
export async function finalizeVersion(
  topicId: string,
  version: number,
  opts: {
    forum_session_id?: string
    verdict_id?: string
  }
): Promise<void> {
  const clueSnapshot = await getCurrentClueSnapshot(topicId)
  const parties = dbGetParties(topicId)
  const reps = dbGetRepresentatives(topicId)

  dbFinalizeVersion(topicId, version, {
    verdict_id: opts.verdict_id,
    forum_session_id: opts.forum_session_id,
    clue_snapshot: clueSnapshot,
    parties_snapshot: JSON.stringify(parties),
    representatives_snapshot: JSON.stringify(reps),
  })

  dbUpdateTopic(topicId, { current_version: version, status: "complete" })
  log.pipeline(`Finalized version ${version}`)
}

// Update forum_session_id on a version mid-pipeline (e.g., after forum stage)
export async function setVersionSessionId(topicId: string, version: number, sessionId: string): Promise<void> {
  dbUpdateVersionField(topicId, version, "forum_session_id", sessionId)
}

// Mark a stage as complete on the version, with relevant snapshot updates
export async function markStageComplete(topicId: string, version: number, stage: string): Promise<void> {
  const state = dbGetState(topicId, version)
  if (!state) return

  const stages = [...state.completed_stages]
  if (!stages.includes(stage)) stages.push(stage)

  const snapshots: Parameters<typeof dbUpdateCompletedStages>[3] = {}

  if (stage === "discovery") {
    snapshots.parties_snapshot = JSON.stringify(dbGetParties(topicId))
  } else if (stage === "enrichment") {
    snapshots.clue_snapshot = await getCurrentClueSnapshot(topicId)
  } else if (stage === "forum_prep") {
    snapshots.representatives_snapshot = JSON.stringify(dbGetRepresentatives(topicId))
  }

  dbUpdateCompletedStages(topicId, version, stages, snapshots)
  log.pipeline(`Version ${version}: marked stage "${stage}" complete (${stages.join(" → ")})`)
}

export async function markStale(topicId: string): Promise<void> {
  dbUpdateTopic(topicId, { status: "stale" })
}

export async function computeDelta(topicId: string) {
  const latest = dbGetLatestCompleteState(topicId)
  if (!latest) return null

  const current = await getCurrentClueSnapshot(topicId)
  const prev = latest.clue_snapshot

  const newClues: string[] = []
  const updatedClues: string[] = []
  const affectedParties = new Set<string>()

  for (const [id, version] of Object.entries(current.ids_and_versions)) {
    if (!(id in prev.ids_and_versions)) {
      newClues.push(id)
    } else if (prev.ids_and_versions[id] !== version) {
      updatedClues.push(id)
    }
  }

  const clues = dbGetClues(topicId)
  for (const id of [...newClues, ...updatedClues]) {
    const clue = clues.find(c => c.id === id)
    if (clue) {
      const cur = clue.versions.find(v => v.v === clue.current)
      cur?.party_relevance.forEach((p: string) => affectedParties.add(p))
    }
  }

  if (newClues.length === 0 && updatedClues.length === 0) return null

  return {
    new_clues: newClues,
    updated_clues: updatedClues,
    affected_parties: [...affectedParties],
    key_change: `${newClues.length} new clue(s), ${updatedClues.length} updated clue(s)`,
  }
}

// Legacy compat -- old code calls createVersion, redirect to allocate+finalize
export async function createVersion(
  topicId: string,
  opts: {
    label: string
    trigger: "initial_run" | "user_add_clue" | "user_edit_clue" | "auto_refresh" | "user_manual"
    forum_session_id?: string
    verdict_id?: string
    delta_from?: number
    delta_summary?: import("../db/queries/states").DeltaSummary
  }
) {
  const states = dbGetAllStates(topicId)
  const version = states.length > 0 ? Math.max(...states.map(s => s.version)) + 1 : 1
  const clueSnapshot = await getCurrentClueSnapshot(topicId)
  const parties = dbGetParties(topicId)
  const reps = dbGetRepresentatives(topicId)

  const state = {
    version,
    label: opts.label,
    created_at: new Date().toISOString(),
    trigger: opts.trigger,
    clue_snapshot: clueSnapshot,
    forum_session_id: opts.forum_session_id ?? null,
    verdict_id: opts.verdict_id ?? null,
    delta_from: opts.delta_from ?? null,
    delta_summary: opts.delta_summary ?? null,
    parent_version: opts.delta_from ?? null,
    fork_stage: null,
    version_status: "complete" as const,
    parties_snapshot: JSON.stringify(parties),
    representatives_snapshot: JSON.stringify(reps),
    completed_stages: STAGE_ORDER,
  }

  dbInsertState(topicId, state)
  dbUpdateTopic(topicId, { current_version: version, status: "complete" })
  return state
}

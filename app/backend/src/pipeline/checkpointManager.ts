import { join } from "path"
import { mkdir } from "fs/promises"

function getDataDir() { return process.env.DATA_DIR || "/home/nima/dana/data" }

export type PipelineStage = "discovery" | "enrichment" | "weight" | "forum_prep" | "forum" | "expert_council" | "verdict"

export interface Checkpoint {
  run_id: string
  topic_id: string
  stage: PipelineStage
  step: number
  completed_turn_ids: string[]
  created_at: string
  updated_at: string
}

function checkpointPath(topicId: string, runId: string): string {
  return join(getDataDir(), "topics", topicId, "logs", `run-${runId}`, "checkpoint.json")
}

export async function writeCheckpoint(
  topicId: string,
  runId: string,
  update: Partial<Omit<Checkpoint, "run_id" | "topic_id" | "created_at">>
): Promise<Checkpoint> {
  const path = checkpointPath(topicId, runId)
  const dir = join(getDataDir(), "topics", topicId, "logs", `run-${runId}`)
  await mkdir(dir, { recursive: true })

  const file = Bun.file(path)
  const existing: Checkpoint | null = (await file.exists()) ? await file.json() : null

  const checkpoint: Checkpoint = {
    run_id: runId,
    topic_id: topicId,
    stage: update.stage ?? existing?.stage ?? "discovery",
    step: update.step ?? existing?.step ?? 0,
    completed_turn_ids: update.completed_turn_ids ?? existing?.completed_turn_ids ?? [],
    created_at: existing?.created_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  await Bun.write(path, JSON.stringify(checkpoint, null, 2))
  return checkpoint
}

export async function readCheckpoint(topicId: string, runId: string): Promise<Checkpoint | null> {
  const file = Bun.file(checkpointPath(topicId, runId))
  if (!(await file.exists())) return null
  return file.json()
}

export async function markTurnComplete(topicId: string, runId: string, turnId: string): Promise<void> {
  const path = checkpointPath(topicId, runId)
  const file = Bun.file(path)
  if (!(await file.exists())) return
  const cp = await file.json() as Checkpoint
  if (!cp.completed_turn_ids.includes(turnId)) {
    cp.completed_turn_ids.push(turnId)
    cp.updated_at = new Date().toISOString()
    await Bun.write(path, JSON.stringify(cp, null, 2))
  }
}

export function isTurnComplete(checkpoint: Checkpoint | null, turnId: string): boolean {
  return checkpoint?.completed_turn_ids.includes(turnId) ?? false
}

export function isStageComplete(checkpoint: Checkpoint | null, stage: PipelineStage): boolean {
  if (!checkpoint) return false
  const order: PipelineStage[] = ["discovery", "enrichment", "weight", "forum_prep", "forum", "expert_council", "verdict"]
  return order.indexOf(checkpoint.stage) > order.indexOf(stage)
}

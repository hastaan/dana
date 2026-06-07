import { getDb } from "../database"

export interface ClueSnapshot {
  count: number
  ids_and_versions: Record<string, number>
}

export interface DeltaSummary {
  new_clues: string[]
  updated_clues: string[]
  affected_parties: string[]
  key_change: string
}

export interface KnowledgeState {
  version: number
  label: string
  created_at: string
  trigger: "initial_run" | "user_add_clue" | "user_edit_clue" | "auto_refresh" | "user_manual"
  clue_snapshot: ClueSnapshot
  forum_session_id: string | null
  verdict_id: string | null
  delta_from: number | null
  delta_summary: DeltaSummary | null
  parent_version: number | null
  fork_stage: string | null
  version_status: "in_progress" | "complete"
  parties_snapshot: string | null
  representatives_snapshot: string | null
  completed_stages: string[]
}

type StateRow = {
  id: number
  topic_id: string
  version: number
  label: string
  created_at: string
  trigger: string
  clue_snapshot: string
  forum_session_id: string | null
  verdict_id: string | null
  delta_from: number | null
  delta_summary: string | null
  parent_version: number | null
  fork_stage: string | null
  version_status: string | null
  parties_snapshot: string | null
  representatives_snapshot: string | null
  completed_stages: string | null
}

function rowToState(row: StateRow): KnowledgeState {
  return {
    version: row.version,
    label: row.label,
    created_at: row.created_at,
    trigger: row.trigger as KnowledgeState["trigger"],
    clue_snapshot: JSON.parse(row.clue_snapshot),
    forum_session_id: row.forum_session_id,
    verdict_id: row.verdict_id,
    delta_from: row.delta_from,
    delta_summary: row.delta_summary ? JSON.parse(row.delta_summary) : null,
    parent_version: row.parent_version ?? null,
    fork_stage: row.fork_stage ?? null,
    version_status: (row.version_status as KnowledgeState["version_status"]) ?? "complete",
    parties_snapshot: row.parties_snapshot ?? null,
    representatives_snapshot: row.representatives_snapshot ?? null,
    completed_stages: row.completed_stages ? JSON.parse(row.completed_stages) : [],
  }
}

export function dbGetAllStates(topicId: string): KnowledgeState[] {
  const rows = getDb().query<StateRow, [string]>(
    "SELECT * FROM states WHERE topic_id = ? ORDER BY version ASC"
  ).all(topicId)
  return rows.map(rowToState)
}

export function dbGetState(topicId: string, version: number): KnowledgeState | null {
  const row = getDb().query<StateRow, [string, number]>(
    "SELECT * FROM states WHERE topic_id = ? AND version = ?"
  ).get(topicId, version)
  return row ? rowToState(row) : null
}

export function dbGetLatestState(topicId: string): KnowledgeState | null {
  const row = getDb().query<StateRow, [string]>(
    "SELECT * FROM states WHERE topic_id = ? ORDER BY version DESC LIMIT 1"
  ).get(topicId)
  return row ? rowToState(row) : null
}

export function dbGetLatestCompleteState(topicId: string): KnowledgeState | null {
  const row = getDb().query<StateRow, [string]>(
    "SELECT * FROM states WHERE topic_id = ? AND version_status = 'complete' ORDER BY version DESC LIMIT 1"
  ).get(topicId)
  return row ? rowToState(row) : null
}

export function dbInsertState(topicId: string, state: Omit<KnowledgeState, "version_status"> & { version_status?: string }): void {
  getDb().run(
    `INSERT INTO states (topic_id, version, label, created_at, trigger, clue_snapshot, forum_session_id, verdict_id, delta_from, delta_summary, parent_version, fork_stage, version_status, parties_snapshot, representatives_snapshot, completed_stages)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(topic_id, version) DO UPDATE SET
       label=excluded.label, version_status=excluded.version_status,
       forum_session_id=COALESCE(excluded.forum_session_id, forum_session_id),
       verdict_id=COALESCE(excluded.verdict_id, verdict_id),
       clue_snapshot=excluded.clue_snapshot,
       parties_snapshot=COALESCE(excluded.parties_snapshot, parties_snapshot),
       representatives_snapshot=COALESCE(excluded.representatives_snapshot, representatives_snapshot),
       completed_stages=excluded.completed_stages`,
    [topicId, state.version, state.label, state.created_at, state.trigger,
     JSON.stringify(state.clue_snapshot), state.forum_session_id ?? null, state.verdict_id ?? null,
     state.delta_from ?? null, state.delta_summary ? JSON.stringify(state.delta_summary) : null,
     state.parent_version ?? null, state.fork_stage ?? null,
     state.version_status ?? "in_progress",
     state.parties_snapshot ?? null, state.representatives_snapshot ?? null,
     JSON.stringify(state.completed_stages ?? [])]
  )
}

export function dbFinalizeVersion(topicId: string, version: number, updates: {
  verdict_id?: string
  forum_session_id?: string
  clue_snapshot?: ClueSnapshot
  parties_snapshot?: string
  representatives_snapshot?: string
}): void {
  const sets: string[] = ["version_status = 'complete'"]
  const params: unknown[] = []

  if (updates.verdict_id) { sets.push("verdict_id = ?"); params.push(updates.verdict_id) }
  if (updates.forum_session_id) { sets.push("forum_session_id = ?"); params.push(updates.forum_session_id) }
  if (updates.clue_snapshot) { sets.push("clue_snapshot = ?"); params.push(JSON.stringify(updates.clue_snapshot)) }
  if (updates.parties_snapshot) { sets.push("parties_snapshot = ?"); params.push(updates.parties_snapshot) }
  if (updates.representatives_snapshot) { sets.push("representatives_snapshot = ?"); params.push(updates.representatives_snapshot) }

  params.push(topicId, version)
  getDb().run(`UPDATE states SET ${sets.join(", ")} WHERE topic_id = ? AND version = ?`, params)
}

export function dbUpdateVersionField(topicId: string, version: number, field: string, value: string | null): void {
  getDb().run(`UPDATE states SET ${field} = ? WHERE topic_id = ? AND version = ?`, [value, topicId, version])
}

export function dbUpdateCompletedStages(topicId: string, version: number, stages: string[], snapshots?: {
  parties_snapshot?: string
  representatives_snapshot?: string
  clue_snapshot?: ClueSnapshot
  forum_session_id?: string
}): void {
  const sets = ["completed_stages = ?"]
  const params: unknown[] = [JSON.stringify(stages)]
  if (snapshots?.parties_snapshot) { sets.push("parties_snapshot = ?"); params.push(snapshots.parties_snapshot) }
  if (snapshots?.representatives_snapshot) { sets.push("representatives_snapshot = ?"); params.push(snapshots.representatives_snapshot) }
  if (snapshots?.clue_snapshot) { sets.push("clue_snapshot = ?"); params.push(JSON.stringify(snapshots.clue_snapshot)) }
  if (snapshots?.forum_session_id) { sets.push("forum_session_id = ?"); params.push(snapshots.forum_session_id) }
  params.push(topicId, version)
  getDb().run(`UPDATE states SET ${sets.join(", ")} WHERE topic_id = ? AND version = ?`, params)
}

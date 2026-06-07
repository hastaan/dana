import { dbGetForumSession, dbUpsertForumSession } from "../../db/queries/forum"

// Re-export types for compatibility
export type { ForumTurn, ForumScenario, ForumSession, ScenarioSummary, EvidenceItem, ChallengeItem } from "../../db/queries/forum"

export async function getPriorTurns(
  topicId: string,
  sessionId: string,
  opts: { round?: number; party_id?: string } = {}
): Promise<import("../../db/queries/forum").ForumTurn[]> {
  const session = dbGetForumSession(topicId, sessionId)
  if (!session) return []
  const allTurns = session.rounds.flatMap(r => r.turns)
  return allTurns.filter(t => {
    if (opts.round !== undefined && t.round !== opts.round) return false
    if (opts.party_id !== undefined && t.representative_id !== `rep-${opts.party_id}`) return false
    return true
  })
}

export async function getScenarioList(topicId: string, sessionId: string): Promise<import("../../db/queries/forum").ForumScenario[]> {
  const session = dbGetForumSession(topicId, sessionId)
  return session?.scenarios ?? []
}

export async function getScenarioSummary(topicId: string, sessionId: string): Promise<import("../../db/queries/forum").ScenarioSummary | null> {
  const session = dbGetForumSession(topicId, sessionId)
  return session?.scenario_summary ?? null
}

export async function getForumSession(topicId: string, sessionId: string): Promise<import("../../db/queries/forum").ForumSession> {
  const session = dbGetForumSession(topicId, sessionId)
  if (!session) throw new Error(`Forum session not found: ${sessionId}`)
  return session
}

export async function writeForumSession(topicId: string, session: import("../../db/queries/forum").ForumSession): Promise<void> {
  dbUpsertForumSession(topicId, session)
}

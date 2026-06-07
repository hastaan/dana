import { getClueIndex } from "../tools/internal/getClue"
import { getPartyIndex } from "../tools/internal/getPartyProfile"
import { dbGetTopic } from "../db/queries/topics"
import { dbGetAllStates } from "../db/queries/states"
import { dbGetForumSession } from "../db/queries/forum"
import { dbGetLatestExpertCouncil } from "../db/queries/expert"

export type AgentType = "discovery" | "enrichment" | "weight" | "forum" | "expert" | "verdict" | "delta"

export interface AgentContextSnapshot {
  current_version: number
  party_index: { id: string; name: string; weight: number }[]
  clue_index: { id: string; title: string; timeline_date: string; party_relevance: string[]; relevance_score: number }[]
  forum_summary?: string
  prior_verdict_summary?: string
}

function getTopicVersion(topicId: string): number {
  return dbGetTopic(topicId)?.current_version ?? 0
}

function getForumSummary(topicId: string): string | undefined {
  const states = dbGetAllStates(topicId)
  if (!states.length) return undefined
  const latest = states[states.length - 1]
  if (!latest.forum_session_id) return undefined

  const session = dbGetForumSession(topicId, latest.forum_session_id)
  if (!session?.scenario_summary?.scenarios?.length) return undefined

  const titles = session.scenario_summary.scenarios.map((s, i) => `${i + 1}. ${s.title}`).join("; ")
  return `Forum produced ${session.scenario_summary.scenarios.length} scenarios: ${titles}`
}

function getVerdictSummary(topicId: string): string | undefined {
  const council = dbGetLatestExpertCouncil(topicId)
  if (!council?.final_verdict?.final_assessment) return undefined
  return council.final_verdict.final_assessment.slice(0, 300)
}

export async function buildAgentContext(
  agentType: AgentType,
  topicId: string
): Promise<AgentContextSnapshot> {
  const [party_index, clue_index] = await Promise.all([
    getPartyIndex(topicId),
    getClueIndex(topicId),
  ])

  const snapshot: AgentContextSnapshot = {
    current_version: getTopicVersion(topicId),
    party_index,
    clue_index,
  }

  // Forum summary: needed by expert and verdict agents (not forum agents themselves)
  if (agentType === "expert" || agentType === "verdict") {
    snapshot.forum_summary = getForumSummary(topicId)
  }

  // Prior verdict summary: only needed for delta agents
  if (agentType === "delta") {
    snapshot.prior_verdict_summary = getVerdictSummary(topicId)
  }

  return snapshot
}

// Rough token estimator: 1 token ≈ 4 chars
export function estimateTokens(snapshot: AgentContextSnapshot): number {
  return Math.ceil(JSON.stringify(snapshot).length / 4)
}

// Serialize snapshot to a compact string for injection into prompts
export function serializeContext(snapshot: AgentContextSnapshot): string {
  const lines: string[] = [
    `Version: ${snapshot.current_version}`,
    `Parties (${snapshot.party_index.length}): ${snapshot.party_index.map(p => `${p.name} [w=${p.weight}]`).join(", ")}`,
    `Clues (${snapshot.clue_index.length}): ${snapshot.clue_index.map(c => `[${c.id}] ${c.title} (${c.timeline_date})`).join(" | ")}`,
  ]
  if (snapshot.forum_summary) lines.push(`Forum summary: ${snapshot.forum_summary}`)
  if (snapshot.prior_verdict_summary) lines.push(`Prior verdict: ${snapshot.prior_verdict_summary}`)
  return lines.join("\n")
}

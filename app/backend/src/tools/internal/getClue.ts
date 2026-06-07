import { dbGetClue, dbGetClueVersion, dbGetClueIndex } from "../../db/queries/clues"
import type { ClueVersion } from "../../db/queries/clues"

export async function getClue(topicId: string, clueId: string, version?: number): Promise<ClueVersion & { bias_flags: string[] }> {
  const entry = dbGetClueVersion(topicId, clueId, version)
  if (!entry) throw new Error(`Clue ${clueId} not found for topic ${topicId}`)
  return { ...entry, bias_flags: entry.source_credibility.bias_flags }
}

export async function getClueIndex(topicId: string): Promise<{ id: string; title: string; timeline_date: string; party_relevance: string[]; relevance_score: number }[]> {
  return dbGetClueIndex(topicId)
}

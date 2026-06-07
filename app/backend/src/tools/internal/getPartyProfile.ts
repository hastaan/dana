import { dbGetParty, dbGetParties } from "../../db/queries/parties"
import type { Party } from "../../db/queries/parties"

export async function getPartyProfile(topicId: string, partyId: string): Promise<Party> {
  const party = dbGetParty(topicId, partyId)
  if (!party) throw new Error(`Party ${partyId} not found for topic ${topicId}`)
  return party
}

export async function getPartyIndex(topicId: string): Promise<{ id: string; name: string; weight: number }[]> {
  return dbGetParties(topicId).map(p => ({ id: p.id, name: p.name, weight: p.weight }))
}

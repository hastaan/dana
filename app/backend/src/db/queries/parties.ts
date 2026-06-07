import { getDb } from "../database"

export interface Party {
  id: string
  name: string
  type: "state" | "state_military" | "non_state" | "individual" | "media" | "economic" | "alliance"
  description: string
  weight: number
  weight_factors: {
    military_capacity: number
    economic_control: number
    information_control: number
    international_support: number
    internal_legitimacy: number
  }
  agenda: string
  means: string[]
  circle: { visible: string[]; shadow: string[] }
  stance: string
  vulnerabilities: string[]
  weight_evidence?: Record<string, string>
  auto_discovered: boolean
  user_verified: boolean
}

type PartyRow = {
  id: string
  topic_id: string
  name: string
  type: string
  description: string
  weight: number
  weight_factors: string
  weight_evidence: string
  agenda: string
  means: string
  circle: string
  stance: string
  vulnerabilities: string
  auto_discovered: number
  user_verified: number
}

function rowToParty(row: PartyRow): Party {
  return {
    id: row.id,
    name: row.name,
    type: row.type as Party["type"],
    description: row.description,
    weight: row.weight,
    weight_factors: JSON.parse(row.weight_factors),
    weight_evidence: JSON.parse(row.weight_evidence || "{}"),
    agenda: row.agenda,
    means: JSON.parse(row.means),
    circle: JSON.parse(row.circle),
    stance: row.stance,
    vulnerabilities: JSON.parse(row.vulnerabilities),
    auto_discovered: Boolean(row.auto_discovered),
    user_verified: Boolean(row.user_verified),
  }
}

export function dbGetParties(topicId: string): Party[] {
  const rows = getDb().query<PartyRow, [string]>(
    "SELECT * FROM parties WHERE topic_id = ?"
  ).all(topicId)
  return rows.map(rowToParty)
}

export function dbGetParty(topicId: string, partyId: string): Party | null {
  const row = getDb().query<PartyRow, [string, string]>(
    "SELECT * FROM parties WHERE topic_id = ? AND id = ?"
  ).get(topicId, partyId)
  return row ? rowToParty(row) : null
}

export function dbUpsertParty(topicId: string, party: Party): void {
  getDb().run(
    `INSERT INTO parties (id, topic_id, name, type, description, weight, weight_factors, weight_evidence, agenda, means, circle, stance, vulnerabilities, auto_discovered, user_verified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id, topic_id) DO UPDATE SET
       name=excluded.name, type=excluded.type, description=excluded.description,
       weight=excluded.weight, weight_factors=excluded.weight_factors, weight_evidence=excluded.weight_evidence,
       agenda=excluded.agenda, means=excluded.means, circle=excluded.circle, stance=excluded.stance,
       vulnerabilities=excluded.vulnerabilities, auto_discovered=excluded.auto_discovered,
       user_verified=excluded.user_verified`,
    [party.id, topicId, party.name, party.type, party.description, party.weight,
     JSON.stringify(party.weight_factors), JSON.stringify(party.weight_evidence ?? {}),
     party.agenda, JSON.stringify(party.means),
     JSON.stringify(party.circle), party.stance, JSON.stringify(party.vulnerabilities),
     party.auto_discovered ? 1 : 0, party.user_verified ? 1 : 0]
  )
}

export function dbSetParties(topicId: string, parties: Party[]): void {
  const db = getDb()
  const txn = db.transaction(() => {
    db.run("DELETE FROM parties WHERE topic_id = ?", [topicId])
    for (const p of parties) dbUpsertParty(topicId, p)
  })
  txn()
}

export function dbDeleteParty(topicId: string, partyId: string): void {
  getDb().run("DELETE FROM parties WHERE topic_id = ? AND id = ?", [topicId, partyId])
}

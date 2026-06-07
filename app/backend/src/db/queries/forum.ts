import { getDb } from "../database"

export interface EvidenceItem {
  claim: string
  clue_id: string
  interpretation: string
}

export interface ChallengeItem {
  target_party: string
  challenge: string
  clue_id?: string
}

export interface ForumTurn {
  id: string
  representative_id: string
  party_name: string
  persona_title?: string
  party_color?: string
  statement: string
  position?: string
  evidence?: EvidenceItem[]
  challenges?: ChallengeItem[]
  concessions?: string[]
  scenario_endorsement?: string
  moderator_directive?: string
  moderator_reason?: string
  clues_cited: string[]
  timestamp: string
  round: number
  type: string
  word_count: number
}

export interface ForumScenario {
  id: string
  title: string
  description: string
  proposed_by: string
  supported_by: string[]
  contested_by: string[]
  clues_cited: string[]
  benefiting_parties: string[]
  required_conditions: string[]
  falsification_conditions: string[]
}

export interface ScenarioSummary {
  scenarios: {
    id: string
    title: string
    key_clues: string[]
    required_conditions: string[]
    falsification_conditions: string[]
  }[]
  contested_clues: {
    clue_id: string
    cited_by: string[]
    conflict: string
  }[]
  uncontested_clues: string[]
}

export interface ForumSession {
  session_id: string
  version: number
  type: "full" | "delta"
  status: "running" | "complete" | "error"
  started_at: string
  completed_at?: string
  rounds: { round: number; type: string; turns: ForumTurn[] }[]
  scenarios: ForumScenario[]
  scenario_summary?: ScenarioSummary
  debate_summary?: string
}

export interface Representative {
  id: string
  party_id: string
  persona_prompt: string
  persona_title: string
  speaking_weight: number
  speaking_budget: {
    opening_statement: number
    rebuttal: number
    closing: number
    minimum_floor: number
  }
  auto_generated: boolean
}

// --- Representatives ---

export function dbGetRepresentatives(topicId: string): Representative[] {
  type Row = {
    id: string; topic_id: string; party_id: string; persona_title: string; persona_prompt: string
    speaking_weight: number; speaking_budget: string; auto_generated: number
  }
  const rows = getDb().query<Row, [string]>(
    "SELECT * FROM representatives WHERE topic_id = ?"
  ).all(topicId)
  return rows.map(r => ({
    id: r.id, party_id: r.party_id, persona_title: r.persona_title, persona_prompt: r.persona_prompt,
    speaking_weight: r.speaking_weight, speaking_budget: JSON.parse(r.speaking_budget),
    auto_generated: Boolean(r.auto_generated),
  }))
}

export function dbSetRepresentatives(topicId: string, reps: Representative[]): void {
  const db = getDb()
  const txn = db.transaction(() => {
    db.run("DELETE FROM representatives WHERE topic_id = ?", [topicId])
    for (const r of reps) {
      db.run(
        `INSERT INTO representatives (id, topic_id, party_id, persona_title, persona_prompt, speaking_weight, speaking_budget, auto_generated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.id, topicId, r.party_id, r.persona_title, r.persona_prompt, r.speaking_weight,
         JSON.stringify(r.speaking_budget), r.auto_generated ? 1 : 0]
      )
    }
  })
  txn()
}

// --- Forum Sessions ---

export function dbGetForumSession(topicId: string, sessionId: string): ForumSession | null {
  const db = getDb()
  type SessionRow = {
    id: string; topic_id: string; version: number; type: string; status: string
    started_at: string; completed_at: string | null; debate_summary: string | null
  }
  const sessionRow = db.query<SessionRow, [string, string]>(
    "SELECT * FROM forum_sessions WHERE topic_id = ? AND id = ?"
  ).get(topicId, sessionId)
  if (!sessionRow) return null

  type RoundRow = { id: number; session_id: string; topic_id: string; round_number: number; round_type: string }
  const roundRows = db.query<RoundRow, [string, string]>(
    "SELECT * FROM forum_rounds WHERE session_id = ? AND topic_id = ? ORDER BY round_number ASC"
  ).all(sessionId, topicId)

  type TurnRow = {
    id: string; round_id: number; topic_id: string; party_id: string; representative_id: string
    party_name: string; persona_title: string | null; position: string | null; evidence: string
    challenges: string; concessions: string; statement: string; scenario_endorsement: string | null
    moderator_directive: string | null; moderator_reason: string | null
    clues_cited: string; word_count: number; round: number; type: string; created_at: string
  }

  const rounds = roundRows.map(r => {
    const turns = db.query<TurnRow, [number]>(
      "SELECT * FROM forum_turns WHERE round_id = ? ORDER BY created_at ASC"
    ).all(r.id)

    return {
      round: r.round_number,
      type: r.round_type,
      turns: turns.map(t => ({
        id: t.id,
        representative_id: t.representative_id,
        party_name: t.party_name,
        persona_title: t.persona_title ?? undefined,
        statement: t.statement,
        position: t.position ?? undefined,
        evidence: JSON.parse(t.evidence),
        challenges: JSON.parse(t.challenges),
        concessions: JSON.parse(t.concessions),
        scenario_endorsement: t.scenario_endorsement ?? undefined,
        moderator_directive: t.moderator_directive ?? undefined,
        moderator_reason: t.moderator_reason ?? undefined,
        clues_cited: JSON.parse(t.clues_cited),
        timestamp: t.created_at,
        round: t.round,
        type: t.type,
        word_count: t.word_count,
      } as ForumTurn)),
    }
  })

  type ScenarioRow = {
    id: string; session_id: string; topic_id: string; title: string; description: string
    proposed_by: string; supported_by: string; contested_by: string; clues_cited: string
    benefiting_parties: string; required_conditions: string; falsification_conditions: string
  }
  const scenarioRows = db.query<ScenarioRow, [string, string]>(
    "SELECT * FROM forum_scenarios WHERE session_id = ? AND topic_id = ?"
  ).all(sessionId, topicId)

  const scenarios: ForumScenario[] = scenarioRows.map(s => ({
    id: s.id, title: s.title, description: s.description, proposed_by: s.proposed_by,
    supported_by: JSON.parse(s.supported_by), contested_by: JSON.parse(s.contested_by),
    clues_cited: JSON.parse(s.clues_cited), benefiting_parties: JSON.parse(s.benefiting_parties),
    required_conditions: JSON.parse(s.required_conditions),
    falsification_conditions: JSON.parse(s.falsification_conditions),
  }))

  type SummaryRow = { session_id: string; topic_id: string; summary: string }
  const summaryRow = db.query<SummaryRow, [string, string]>(
    "SELECT * FROM forum_scenario_summaries WHERE session_id = ? AND topic_id = ?"
  ).get(sessionId, topicId)

  return {
    session_id: sessionRow.id,
    version: sessionRow.version,
    type: sessionRow.type as ForumSession["type"],
    status: sessionRow.status as ForumSession["status"],
    started_at: sessionRow.started_at,
    completed_at: sessionRow.completed_at ?? undefined,
    rounds,
    scenarios,
    scenario_summary: summaryRow ? JSON.parse(summaryRow.summary) : undefined,
    debate_summary: sessionRow.debate_summary ?? undefined,
  }
}

export function dbUpsertForumSession(topicId: string, session: ForumSession): void {
  const db = getDb()
  const txn = db.transaction(() => {
    // Clean up old rounds/turns for this session before re-creating (prevents accumulation across re-runs)
    if (session.status === "running") {
      const oldRounds = db.query<{ id: number }, [string, string]>(
        "SELECT id FROM forum_rounds WHERE session_id = ? AND topic_id = ?"
      ).all(session.session_id, topicId)
      for (const r of oldRounds) {
        db.run("DELETE FROM forum_turns WHERE round_id = ?", [r.id])
      }
      db.run("DELETE FROM forum_rounds WHERE session_id = ? AND topic_id = ?", [session.session_id, topicId])
    }

    db.run(
      `INSERT INTO forum_sessions (id, topic_id, version, type, status, started_at, completed_at, debate_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id, topic_id) DO UPDATE SET status=excluded.status, completed_at=excluded.completed_at, version=excluded.version, started_at=excluded.started_at, debate_summary=excluded.debate_summary`,
      [session.session_id, topicId, session.version, session.type, session.status,
       session.started_at, session.completed_at ?? null, session.debate_summary ?? null]
    )

    // Upsert rounds and turns
    for (const r of session.rounds) {
      type RoundIdRow = { id: number }
      let roundId: number
      const existing = db.query<RoundIdRow, [string, string, number]>(
        "SELECT id FROM forum_rounds WHERE session_id = ? AND topic_id = ? AND round_number = ?"
      ).get(session.session_id, topicId, r.round)

      if (existing) {
        roundId = existing.id
      } else {
        db.run(
          "INSERT INTO forum_rounds (session_id, topic_id, round_number, round_type) VALUES (?, ?, ?, ?)",
          [session.session_id, topicId, r.round, r.type]
        )
        roundId = db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id
      }

      // Upsert turns
      for (const t of r.turns) {
        db.run(
          `INSERT INTO forum_turns (id, round_id, topic_id, party_id, representative_id, party_name, persona_title, position, evidence, challenges, concessions, statement, scenario_endorsement, moderator_directive, moderator_reason, clues_cited, word_count, round, type, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id, topic_id) DO UPDATE SET statement=excluded.statement, word_count=excluded.word_count, moderator_directive=excluded.moderator_directive, moderator_reason=excluded.moderator_reason`,
          [t.id, roundId, topicId, t.representative_id.replace("rep-", ""), t.representative_id,
           t.party_name, t.persona_title ?? null, t.position ?? null,
           JSON.stringify(t.evidence ?? []), JSON.stringify(t.challenges ?? []),
           JSON.stringify(t.concessions ?? []), t.statement,
           t.scenario_endorsement ?? null, t.moderator_directive ?? null, t.moderator_reason ?? null,
           JSON.stringify(t.clues_cited),
           t.word_count, t.round, t.type, t.timestamp]
        )
      }
    }

    // Upsert scenarios
    db.run("DELETE FROM forum_scenarios WHERE session_id = ? AND topic_id = ?", [session.session_id, topicId])
    for (const s of session.scenarios) {
      db.run(
        `INSERT INTO forum_scenarios (id, session_id, topic_id, title, description, proposed_by, supported_by, contested_by, clues_cited, benefiting_parties, required_conditions, falsification_conditions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [s.id, session.session_id, topicId, s.title, s.description, s.proposed_by,
         JSON.stringify(s.supported_by), JSON.stringify(s.contested_by), JSON.stringify(s.clues_cited),
         JSON.stringify(s.benefiting_parties), JSON.stringify(s.required_conditions),
         JSON.stringify(s.falsification_conditions)]
      )
    }

    // Upsert scenario summary
    if (session.scenario_summary) {
      db.run(
        `INSERT INTO forum_scenario_summaries (session_id, topic_id, summary)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id, topic_id) DO UPDATE SET summary=excluded.summary`,
        [session.session_id, topicId, JSON.stringify(session.scenario_summary)]
      )
    }
  })
  txn()
}

// ─── Scratchpad types & queries ───────────────────────────────────────────────

export interface ScratchpadContent {
  clue_analysis: {
    clue_id: string
    r: "S" | "W" | "N"                // S=supports, W=weakens, N=neutral
    use: string
    counter: string
    credibility_attack?: string        // how to use credibility/bias to attack this evidence
    // legacy field names — kept for backward compat with full-format scratchpads
    relevance_to_us?: string
    how_we_use_it?: string
    our_counter_if_used_against_us?: string
  }[]
  our_core_position: string
  scenario_we_are_pushing: string
  strongest_opposing_party: string
  attack_strategy?: string             // how to exploit opponent's vulnerability
  our_key_vulnerabilities: string[]
  opening_move: string
}

export interface Scratchpad {
  representative_id: string
  session_id: string
  topic_id: string
  party_id: string
  content: ScratchpadContent
  created_at: string
}

export function dbWriteScratchpad(topicId: string, pad: Scratchpad): void {
  getDb().run(
    `INSERT INTO forum_scratchpads (representative_id, session_id, topic_id, party_id, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(representative_id, session_id, topic_id) DO UPDATE SET content=excluded.content`,
    [pad.representative_id, pad.session_id, topicId, pad.party_id,
     JSON.stringify(pad.content), pad.created_at]
  )
}

export function dbGetScratchpad(topicId: string, sessionId: string, representativeId: string): Scratchpad | null {
  type Row = { representative_id: string; session_id: string; topic_id: string; party_id: string; content: string; created_at: string }
  const row = getDb().query<Row, [string, string, string]>(
    "SELECT * FROM forum_scratchpads WHERE topic_id = ? AND session_id = ? AND representative_id = ?"
  ).get(topicId, sessionId, representativeId)
  if (!row) return null
  return { ...row, content: JSON.parse(row.content) as ScratchpadContent }
}

export function dbGetAllScratchpads(topicId: string, sessionId: string): Scratchpad[] {
  type Row = { representative_id: string; session_id: string; topic_id: string; party_id: string; content: string; created_at: string }
  const rows = getDb().query<Row, [string, string]>(
    "SELECT * FROM forum_scratchpads WHERE topic_id = ? AND session_id = ?"
  ).all(topicId, sessionId)
  return rows.map(r => ({ ...r, content: JSON.parse(r.content) as ScratchpadContent }))
}

// ─── Supervisor state types & queries ────────────────────────────────────────

export interface SupervisorState {
  session_id: string
  topic_id: string
  turn_count: number
  turn_distribution: Record<string, number>
  live_scenarios: ForumScenario[]
  compressed_history: string
  status: "running" | "done"
  closure_reason?: string
  updated_at: string
}

export function dbUpsertSupervisorState(topicId: string, state: SupervisorState): void {
  getDb().run(
    `INSERT INTO forum_supervisor_state
       (session_id, topic_id, turn_count, turn_distribution, live_scenarios, compressed_history, status, closure_reason, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, topic_id) DO UPDATE SET
       turn_count=excluded.turn_count, turn_distribution=excluded.turn_distribution,
       live_scenarios=excluded.live_scenarios, compressed_history=excluded.compressed_history,
       status=excluded.status, closure_reason=excluded.closure_reason, updated_at=excluded.updated_at`,
    [state.session_id, topicId, state.turn_count, JSON.stringify(state.turn_distribution),
     JSON.stringify(state.live_scenarios), state.compressed_history,
     state.status, state.closure_reason ?? null, state.updated_at]
  )
}

export function dbGetSupervisorState(topicId: string, sessionId: string): SupervisorState | null {
  type Row = {
    session_id: string; topic_id: string; turn_count: number; turn_distribution: string
    live_scenarios: string; compressed_history: string; status: string; closure_reason: string | null; updated_at: string
  }
  const row = getDb().query<Row, [string, string]>(
    "SELECT * FROM forum_supervisor_state WHERE topic_id = ? AND session_id = ?"
  ).get(topicId, sessionId)
  if (!row) return null
  return {
    session_id: row.session_id,
    topic_id: row.topic_id,
    turn_count: row.turn_count,
    turn_distribution: JSON.parse(row.turn_distribution),
    live_scenarios: JSON.parse(row.live_scenarios),
    compressed_history: row.compressed_history,
    status: row.status as SupervisorState["status"],
    closure_reason: row.closure_reason ?? undefined,
    updated_at: row.updated_at,
  }
}

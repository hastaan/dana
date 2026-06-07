import { getDb } from "../database"

export interface OriginSource {
  url: string
  outlet: string
  is_republication: boolean
}

export interface FactCheckResult {
  verdict: "verified" | "disputed" | "misleading" | "unverifiable"
  bias_analysis: string
  counter_evidence: string
  cui_bono: string
  adjusted_credibility: number
  adjusted_bias_flags: string[]
  checked_at: string
}

export interface ClueVersion {
  v: number
  date: string
  title: string
  raw_source: {
    urls: string[]
    outlets: string[]
    fetched_at: string
    url?: string              // legacy single-source compat
    raw_text_file?: string
  }
  source_credibility: {
    score: number
    notes: string
    bias_flags: string[]
    origin_sources: OriginSource[]
    origin_source?: OriginSource  // legacy compat
  }
  bias_corrected_summary: string
  relevance_score: number
  party_relevance: string[]
  domain_tags: string[]
  timeline_date: string
  clue_type: string
  change_note: string
  key_points: string[]
  fact_check?: FactCheckResult
}

export type ClueStatus = "raw" | "processing" | "pending" | "verified" | "disputed" | "misleading" | "unverifiable"

export interface Clue {
  id: string
  current: number
  added_at: string
  last_updated_at: string
  added_by: "auto" | "user" | "research" | "cleanup"
  versions: ClueVersion[]
  status: ClueStatus
}

type ClueRow = {
  id: string
  topic_id: string
  current_version: number
  status: string
  added_by: string
  added_at: string
  last_updated_at: string
}

type ClueVersionRow = {
  clue_id: string
  topic_id: string
  version: number
  date: string
  title: string
  raw_source: string
  source_credibility: string
  bias_corrected_summary: string
  relevance_score: number
  party_relevance: string
  domain_tags: string
  timeline_date: string
  clue_type: string
  change_note: string
  key_points: string
  fact_check: string
}

function migrateRawSource(raw: any): ClueVersion["raw_source"] {
  if (raw.urls) return raw
  // Legacy: single url → array
  return { urls: raw.url ? [raw.url] : [], outlets: [], fetched_at: raw.fetched_at ?? "", raw_text_file: raw.raw_text_file }
}

function migrateCredibility(cred: any): ClueVersion["source_credibility"] {
  if (cred.origin_sources) return cred
  // Legacy: single origin_source → array
  const sources: OriginSource[] = cred.origin_source ? [cred.origin_source] : []
  return { score: cred.score, notes: cred.notes, bias_flags: cred.bias_flags ?? [], origin_sources: sources }
}

function versionRowToClueVersion(row: ClueVersionRow): ClueVersion {
  const rawSource = migrateRawSource(JSON.parse(row.raw_source))
  const cred = migrateCredibility(JSON.parse(row.source_credibility))
  const kp = JSON.parse(row.key_points)
  const fc = row.fact_check ? JSON.parse(row.fact_check) : undefined
  const factCheck = fc?.verdict ? fc as FactCheckResult : undefined
  return {
    v: row.version,
    date: row.date,
    title: row.title,
    raw_source: rawSource,
    source_credibility: cred,
    bias_corrected_summary: row.bias_corrected_summary,
    relevance_score: row.relevance_score,
    party_relevance: JSON.parse(row.party_relevance),
    domain_tags: JSON.parse(row.domain_tags),
    timeline_date: row.timeline_date,
    clue_type: row.clue_type,
    change_note: row.change_note,
    key_points: kp,
    fact_check: factCheck,
  }
}

export function dbGetClues(topicId: string): Clue[] {
  const db = getDb()
  const clueRows = db.query<ClueRow, [string]>(
    "SELECT * FROM clues WHERE topic_id = ? ORDER BY id ASC"
  ).all(topicId)

  return clueRows.map(row => {
    const versionRows = db.query<ClueVersionRow, [string, string]>(
      "SELECT * FROM clue_versions WHERE clue_id = ? AND topic_id = ? ORDER BY version ASC"
    ).all(row.id, topicId)

    return {
      id: row.id,
      current: row.current_version,
      added_at: row.added_at,
      last_updated_at: row.last_updated_at,
      added_by: row.added_by as Clue["added_by"],
      status: row.status as Clue["status"],
      versions: versionRows.map(versionRowToClueVersion),
    }
  })
}

export function dbGetCluesAtSnapshot(topicId: string, snapshot: { ids_and_versions: Record<string, number> }): Clue[] {
  const all = dbGetClues(topicId)
  return all
    .filter(c => c.id in snapshot.ids_and_versions)
    .map(c => {
      const pinnedVersion = snapshot.ids_and_versions[c.id]
      return {
        ...c,
        current: pinnedVersion,
        versions: c.versions.filter(v => v.v <= pinnedVersion),
      }
    })
}

export function dbGetClue(topicId: string, clueId: string): Clue | null {
  const db = getDb()
  const row = db.query<ClueRow, [string, string]>(
    "SELECT * FROM clues WHERE topic_id = ? AND id = ?"
  ).get(topicId, clueId)
  if (!row) return null

  const versionRows = db.query<ClueVersionRow, [string, string]>(
    "SELECT * FROM clue_versions WHERE clue_id = ? AND topic_id = ? ORDER BY version ASC"
  ).all(clueId, topicId)

  return {
    id: row.id,
    current: row.current_version,
    added_at: row.added_at,
    last_updated_at: row.last_updated_at,
    added_by: row.added_by as Clue["added_by"],
    status: row.status as Clue["status"],
    versions: versionRows.map(versionRowToClueVersion),
  }
}

export function dbGetClueVersion(topicId: string, clueId: string, version?: number): ClueVersion | null {
  const clue = dbGetClue(topicId, clueId)
  if (!clue) return null
  const v = version ?? clue.current
  return clue.versions.find(ver => ver.v === v) ?? null
}

export function dbGetClueIndex(topicId: string): { id: string; title: string; timeline_date: string; party_relevance: string[]; relevance_score: number }[] {
  const db = getDb()
  type IndexRow = {
    clue_id: string
    current_version: number
    title: string
    timeline_date: string
    party_relevance: string
    relevance_score: number
  }
  const rows = db.query<IndexRow, [string]>(`
    SELECT c.id as clue_id, c.current_version, cv.title, cv.timeline_date, cv.party_relevance, cv.relevance_score
    FROM clues c
    JOIN clue_versions cv ON cv.clue_id = c.id AND cv.topic_id = c.topic_id AND cv.version = c.current_version
    WHERE c.topic_id = ?
    ORDER BY c.id ASC
  `).all(topicId)

  return rows.map(r => ({
    id: r.clue_id,
    title: r.title,
    timeline_date: r.timeline_date,
    party_relevance: JSON.parse(r.party_relevance),
    relevance_score: r.relevance_score,
  }))
}

export function dbInsertClue(topicId: string, clue: Omit<Clue, "versions"> & { version: ClueVersion }): void {
  const db = getDb()
  const txn = db.transaction(() => {
    db.run(
      `INSERT INTO clues (id, topic_id, current_version, status, added_by, added_at, last_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [clue.id, topicId, clue.current, clue.status, clue.added_by, clue.added_at, clue.last_updated_at]
    )
    const v = clue.version
    db.run(
      `INSERT INTO clue_versions (clue_id, topic_id, version, date, title, raw_source, source_credibility, bias_corrected_summary, relevance_score, party_relevance, domain_tags, timeline_date, clue_type, change_note, key_points, fact_check)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [clue.id, topicId, v.v, v.date, v.title, JSON.stringify(v.raw_source),
       JSON.stringify(v.source_credibility), v.bias_corrected_summary, v.relevance_score,
       JSON.stringify(v.party_relevance), JSON.stringify(v.domain_tags), v.timeline_date,
       v.clue_type, v.change_note, JSON.stringify(v.key_points), JSON.stringify(v.fact_check ?? {})]
    )
  })
  txn()
}

export function dbUpdateClueVersion(topicId: string, clueId: string, patch: Partial<ClueVersion>): void {
  const clue = dbGetClue(topicId, clueId)
  if (!clue) return
  const existing = clue.versions.find(v => v.v === clue.current)
  if (!existing) return
  const updated = { ...existing, ...patch }
  const db = getDb()
  db.run(
    `UPDATE clue_versions SET title=?, bias_corrected_summary=?, relevance_score=?, party_relevance=?, domain_tags=?, timeline_date=?, clue_type=?, change_note=?, key_points=?, source_credibility=?, fact_check=?
     WHERE clue_id=? AND topic_id=? AND version=?`,
    [updated.title, updated.bias_corrected_summary, updated.relevance_score,
     JSON.stringify(updated.party_relevance), JSON.stringify(updated.domain_tags),
     updated.timeline_date, updated.clue_type, updated.change_note, JSON.stringify(updated.key_points),
     JSON.stringify(updated.source_credibility), JSON.stringify(updated.fact_check ?? {}), clueId, topicId, clue.current]
  )
  db.run(
    "UPDATE clues SET last_updated_at=? WHERE id=? AND topic_id=?",
    [new Date().toISOString(), clueId, topicId]
  )
}

export function dbAddClueVersion(topicId: string, clueId: string, version: ClueVersion): void {
  const db = getDb()
  const txn = db.transaction(() => {
    db.run(
      `INSERT INTO clue_versions (clue_id, topic_id, version, date, title, raw_source, source_credibility, bias_corrected_summary, relevance_score, party_relevance, domain_tags, timeline_date, clue_type, change_note, key_points, fact_check)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [clueId, topicId, version.v, version.date, version.title, JSON.stringify(version.raw_source),
       JSON.stringify(version.source_credibility), version.bias_corrected_summary, version.relevance_score,
       JSON.stringify(version.party_relevance), JSON.stringify(version.domain_tags), version.timeline_date,
       version.clue_type, version.change_note, JSON.stringify(version.key_points), JSON.stringify(version.fact_check ?? {})]
    )
    db.run(
      "UPDATE clues SET current_version=?, last_updated_at=?, status=? WHERE id=? AND topic_id=?",
      [version.v, new Date().toISOString(), "pending", clueId, topicId]
    )
  })
  txn()
}

export function dbDeleteClue(topicId: string, clueId: string): void {
  getDb().run("DELETE FROM clues WHERE topic_id = ? AND id = ?", [topicId, clueId])
}

export function dbReplaceClues(topicId: string, clues: Clue[]): void {
  const db = getDb()
  const txn = db.transaction(() => {
    db.run("DELETE FROM clues WHERE topic_id = ?", [topicId])
    for (const clue of clues) {
      db.run(
        `INSERT INTO clues (id, topic_id, current_version, status, added_by, added_at, last_updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [clue.id, topicId, clue.current, clue.status, clue.added_by, clue.added_at, clue.last_updated_at]
      )
      for (const v of clue.versions) {
        db.run(
          `INSERT INTO clue_versions (clue_id, topic_id, version, date, title, raw_source, source_credibility, bias_corrected_summary, relevance_score, party_relevance, domain_tags, timeline_date, clue_type, change_note, key_points, fact_check)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [clue.id, topicId, v.v, v.date, v.title, JSON.stringify(v.raw_source),
           JSON.stringify(v.source_credibility), v.bias_corrected_summary, v.relevance_score,
           JSON.stringify(v.party_relevance), JSON.stringify(v.domain_tags), v.timeline_date,
           v.clue_type, v.change_note, JSON.stringify(v.key_points), JSON.stringify(v.fact_check ?? {})]
        )
      }
    }
  })
  txn()
}

export function dbCountClues(topicId: string): number {
  const row = getDb().query<{ count: number }, [string]>(
    "SELECT COUNT(*) as count FROM clues WHERE topic_id = ?"
  ).get(topicId)
  return row?.count ?? 0
}

export function dbNextClueId(topicId: string): string {
  const count = dbCountClues(topicId)
  return `clue-${String(count + 1).padStart(3, "0")}`
}

export function dbClueExists(topicId: string, sourceUrl: string, timelineDate: string): string | null {
  if (!sourceUrl) return null
  type Row = { id: string }
  // Check both new (urls array) and legacy (url string) formats
  const row = getDb().query<Row, [string, string, string, string]>(`
    SELECT c.id FROM clues c
    JOIN clue_versions cv ON cv.clue_id = c.id AND cv.topic_id = c.topic_id AND cv.version = c.current_version
    WHERE c.topic_id = ?
      AND (JSON_EXTRACT(cv.raw_source, '$.urls[0]') = ? OR JSON_EXTRACT(cv.raw_source, '$.url') = ?)
      AND cv.timeline_date = ?
    LIMIT 1
  `).get(topicId, sourceUrl, sourceUrl, timelineDate)
  return row?.id ?? null
}

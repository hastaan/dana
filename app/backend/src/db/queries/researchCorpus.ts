import { getDb } from "../database"
import type { SearchResult } from "../../tools/external/webSearch"

// --- Types ---

export interface StoredSearch {
  id: number
  topicId: string
  query: string
  results: SearchResult[]
  resultCount: number
  searchedAt: string
  stage: string
}

export interface StoredPage {
  id: number
  topicId: string
  url: string
  title: string
  content: string
  contentLength: number
  fetchedAt: string
  stage: string
}

// --- Stop words for query normalization ---

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "has", "have", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "not", "no", "its", "it",
  "this", "that", "these", "those", "what", "which", "who", "whom",
  "how", "when", "where", "why", "about", "into", "through", "during",
  "before", "after", "above", "below", "between", "up", "down", "out",
  "off", "over", "under", "again", "further", "then", "once", "as",
  "so", "than", "too", "very", "just", "also",
])

function extractKeywords(query: string): Set<string> {
  return new Set(
    query.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 1 && !STOP_WORDS.has(w))
  )
}

function keywordOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const w of a) { if (b.has(w)) shared++ }
  return shared / Math.max(a.size, b.size)
}

// --- Store ---

export function storeSearch(topicId: string, query: string, results: SearchResult[], stage: string): void {
  const db = getDb()
  db.run(
    `INSERT INTO research_searches (topic_id, query, results, result_count, searched_at, stage)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [topicId, query, JSON.stringify(results), results.length, new Date().toISOString(), stage]
  )
}

export function storePage(topicId: string, url: string, title: string, content: string, stage: string): number {
  const db = getDb()
  const existing = db.query<{ id: number }, [string, string]>(
    "SELECT id FROM research_pages WHERE topic_id = ? AND url = ?"
  ).get(topicId, url)

  if (existing) return existing.id

  db.run(
    `INSERT INTO research_pages (topic_id, url, title, content, content_length, fetched_at, stage)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [topicId, url, title, content, content.length, new Date().toISOString(), stage]
  )

  const row = db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()
  return row?.id ?? 0
}

// --- Query ---

export function findSimilarSearches(topicId: string, query: string, minOverlap = 0.7): StoredSearch[] {
  const db = getDb()
  const queryKeywords = extractKeywords(query)
  if (queryKeywords.size === 0) return []

  const rows = db.query<{
    id: number; topic_id: string; query: string; results: string;
    result_count: number; searched_at: string; stage: string
  }, [string]>(
    "SELECT * FROM research_searches WHERE topic_id = ? ORDER BY searched_at DESC"
  ).all(topicId)

  const matches: StoredSearch[] = []
  for (const row of rows) {
    const storedKeywords = extractKeywords(row.query)
    const overlap = keywordOverlap(queryKeywords, storedKeywords)
    if (overlap >= minOverlap) {
      matches.push({
        id: row.id,
        topicId: row.topic_id,
        query: row.query,
        results: JSON.parse(row.results) as SearchResult[],
        resultCount: row.result_count,
        searchedAt: row.searched_at,
        stage: row.stage,
      })
    }
  }

  return matches
}

export function getPage(topicId: string, url: string): StoredPage | null {
  const db = getDb()
  const row = db.query<{
    id: number; topic_id: string; url: string; title: string;
    content: string; content_length: number; fetched_at: string; stage: string
  }, [string, string]>(
    "SELECT * FROM research_pages WHERE topic_id = ? AND url = ?"
  ).get(topicId, url)

  if (!row) return null

  return {
    id: row.id,
    topicId: row.topic_id,
    url: row.url,
    title: row.title,
    content: row.content,
    contentLength: row.content_length,
    fetchedAt: row.fetched_at,
    stage: row.stage,
  }
}

export function getPagesForParty(topicId: string, partyName: string, limit = 20): StoredPage[] {
  const db = getDb()
  const keywords = partyName.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w))
  if (keywords.length === 0) return []

  // Match pages where title or content contains party name keywords
  const conditions = keywords.map(() => "(LOWER(title) LIKE ? OR LOWER(content) LIKE ?)").join(" AND ")
  const params: string[] = [topicId]
  for (const kw of keywords) {
    params.push(`%${kw}%`, `%${kw}%`)
  }

  const rows = db.query<{
    id: number; topic_id: string; url: string; title: string;
    content: string; content_length: number; fetched_at: string; stage: string
  }, string[]>(
    `SELECT * FROM research_pages WHERE topic_id = ? AND ${conditions} ORDER BY fetched_at DESC LIMIT ${limit}`
  ).all(...params)

  return rows.map(row => ({
    id: row.id,
    topicId: row.topic_id,
    url: row.url,
    title: row.title,
    content: row.content,
    contentLength: row.content_length,
    fetchedAt: row.fetched_at,
    stage: row.stage,
  }))
}

// --- Stats / Summary ---

export function getCorpusStats(topicId: string): { searches: number; pages: number; totalChars: number } {
  const db = getDb()
  const searches = db.query<{ c: number }, [string]>(
    "SELECT COUNT(*) as c FROM research_searches WHERE topic_id = ?"
  ).get(topicId)?.c ?? 0

  const pages = db.query<{ c: number; t: number }, [string]>(
    "SELECT COUNT(*) as c, COALESCE(SUM(content_length), 0) as t FROM research_pages WHERE topic_id = ?"
  ).get(topicId)

  return {
    searches,
    pages: pages?.c ?? 0,
    totalChars: pages?.t ?? 0,
  }
}

export function getCorpusSummary(topicId: string, maxChars = 4000): string {
  const db = getDb()
  const pages = db.query<{
    url: string; title: string; content: string; content_length: number
  }, [string]>(
    "SELECT url, title, content, content_length FROM research_pages WHERE topic_id = ? ORDER BY fetched_at DESC"
  ).all(topicId)

  if (pages.length === 0) return ""

  const lines: string[] = [`Research corpus: ${pages.length} pages fetched`]
  let chars = lines[0].length

  for (const p of pages) {
    const preview = p.content.slice(0, 200).replace(/\n/g, " ")
    const line = `- [${p.title}](${p.url}): ${preview}...`
    if (chars + line.length > maxChars) break
    lines.push(line)
    chars += line.length
  }

  return lines.join("\n")
}

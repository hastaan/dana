import { webSearch, type SearchResult } from "./webSearch"

export interface TimelineEvent {
  date: string
  event: string
  source_url: string
  relevance: number
}

export async function timelineLookup(
  entity: string,
  eventType: string,
  dateRange: { from: string; to: string }
): Promise<TimelineEvent[]> {
  const query = `${entity} ${eventType} ${dateRange.from} ${dateRange.to}`
  const results: SearchResult[] = await webSearch(query, 8, `after:${dateRange.from}`)

  // Extract date patterns from snippets and build timeline events
  const events: TimelineEvent[] = []
  const datePattern = /\b(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\w+ \d{1,2},? \d{4}|\d{1,2} \w+ \d{4})\b/

  for (const r of results) {
    const dateMatch = r.snippet.match(datePattern)
    const date = dateMatch ? dateMatch[1] : dateRange.from

    // Simple relevance: count how many query terms appear in title+snippet
    const terms = [entity, eventType].flatMap(t => t.toLowerCase().split(/\s+/))
    const text = (r.title + " " + r.snippet).toLowerCase()
    const relevance = terms.filter(t => text.includes(t)).length / terms.length

    events.push({
      date,
      event: r.title + (r.snippet ? ": " + r.snippet : ""),
      source_url: r.url,
      relevance: Math.round(relevance * 100),
    })
  }

  // Sort by relevance desc
  return events.sort((a, b) => b.relevance - a.relevance)
}

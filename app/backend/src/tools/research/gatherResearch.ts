import { webSearch } from "../external/webSearch"
import { httpFetch } from "../external/httpFetch"
import { storeSearch, storePage, findSimilarSearches, getPage } from "../../db/queries/researchCorpus"
import { dbGetControls } from "../../db/queries/settings"
import { emitThink } from "../../routes/stream"
import { log } from "../../utils/logger"

function isFetchable(url: string): boolean {
  const skip = ["x.com", "twitter.com", "instagram.com", "facebook.com", "truthsocial.com", "t.me"]
  try {
    const host = new URL(url).hostname
    return !skip.some(s => host.includes(s))
  } catch { return false }
}

export async function gatherResearch(
  queries: string[],
  topicId: string,
  stage: string,
  opts?: { maxQueries?: number; maxSnippetChars?: number }
): Promise<string> {
  const controls = dbGetControls()
  const cacheMaxAgeMs = controls.corpus_cache_hours * 60 * 60 * 1000
  const maxQueries = opts?.maxQueries ?? controls.smart_edit_queries
  const maxSnippetChars = opts?.maxSnippetChars ?? controls.smart_edit_max_chars
  const snippets: string[] = []

  for (const query of queries.slice(0, maxQueries)) {
    try {
      await new Promise(r => setTimeout(r, 400))
      emitThink(topicId, "🔎", "Searching", query)
      log.stage(stage, `Research query: "${query}"`)

      // Check corpus first
      let results = await (async () => {
        try {
          const cached = findSimilarSearches(topicId, query)
          if (cached.length > 0) {
            const age = Date.now() - new Date(cached[0].searchedAt).getTime()
            if (age < cacheMaxAgeMs && cached[0].resultCount > 0) {
              log.stage(stage, `Research CORPUS HIT: "${query}" → ${cached[0].resultCount} cached from "${cached[0].query}"`)
              emitThink(topicId, "📦", `Corpus hit: ${cached[0].resultCount} cached`, cached[0].query)
              return cached[0].results
            }
          }
        } catch { /* fall through to live search */ }
        return null
      })()

      if (!results) {
        results = await webSearch(query, 3)
        try { storeSearch(topicId, query, results, stage) } catch { /* non-fatal */ }
      }

      log.stage(stage, `Research: "${query}" → ${results.length} results`)
      emitThink(topicId, "📄", `Found ${results.length} results`, results.slice(0, 3).map(r => r.title).join(", "))

      for (const r of results.slice(0, 2)) {
        if (!isFetchable(r.url)) {
          if (r.snippet) snippets.push(`[${r.title}] ${r.snippet}`)
          continue
        }

        try {
          emitThink(topicId, "🌐", "Fetching", r.title)

          // Check corpus for cached page
          let title: string
          let content: string
          const cachedPage = (() => { try { return getPage(topicId, r.url) } catch { return null } })()

          if (cachedPage) {
            title = cachedPage.title
            content = cachedPage.content
            log.stage(stage, `Research CORPUS HIT: "${title}" (${cachedPage.contentLength} chars)`)
            emitThink(topicId, "📦", "Corpus hit", `${title} (${cachedPage.contentLength} chars)`)
          } else {
            const fetched = await httpFetch(r.url)
            title = fetched.title
            content = fetched.raw_content
            try { storePage(topicId, r.url, title, content, stage) } catch { /* non-fatal */ }
            emitThink(topicId, "✓", "Fetched", `${title} (${content.length} chars)`)
          }

          snippets.push(`[${title}]\n${content.slice(0, 2000)}`)
        } catch (fetchErr) {
          log.stage(stage, `Research fetch failed for ${r.url}: ${fetchErr instanceof Error ? fetchErr.message : fetchErr}`)
          if (r.snippet) snippets.push(`[${r.title}] ${r.snippet}`)
        }
      }
    } catch (searchErr) {
      log.stage(stage, `Research search failed for "${query}": ${searchErr instanceof Error ? searchErr.message : searchErr}`)
      emitThink(topicId, "⚠", "Search failed", searchErr instanceof Error ? searchErr.message : String(searchErr))
    }
  }

  log.stage(stage, `Research complete: ${snippets.length} snippets, ${snippets.join("").length} chars`)
  emitThink(topicId, "📊", "Research complete", `${snippets.length} snippets gathered`)
  return snippets.join("\n\n---\n\n").slice(0, maxSnippetChars)
}

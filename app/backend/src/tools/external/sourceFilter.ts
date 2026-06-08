// Source-quality filter (⇄ server-py rigor/sources.py).
//
// STORM-style filters block "generally unreliable" sources for Wikipedia-style neutrality —
// including state and partisan media. Dana is the opposite: to analyze a conflict it must HEAR
// every party's own voice (state media, partisan outlets) and let the credibility scorer weight
// it down. So this filter drops ONLY clear fabrication / hoax / SEO-spam / malware domains that
// carry no analytical signal — never legitimate-but-biased outlets.
//
// Conservative by design: when in doubt, let a source through (it gets a low credibility score
// elsewhere) rather than silently erase a party's primary voice.

import type { SearchResult } from "./webSearch"

// Fabrication / hoax / conspiracy content-mills and known SEO/scam farms. NOT state or
// partisan media (those are valid evidence here, scored for credibility downstream).
const UNRELIABLE_DOMAINS: ReadonlySet<string> = new Set([
  "infowars.com", "beforeitsnews.com", "naturalnews.com", "yournewswire.com",
  "newspunch.com", "worldnewsdailyreport.com", "empirenews.net", "nationalreport.net",
  "theonion.com", "babylonbee.com", "clickhole.com",  // satire — not factual evidence
  "globalresearch.ca", "veteranstoday.com", "thegatewaypundit.com", "dailybuzzlive.com",
  "react365.com", "channel45news.com", "now8news.com", "huzlers.com",
])

function domainOf(url: string): string {
  try {
    return (new URL(url).hostname || "").replace(/^www\./, "").toLowerCase()
  } catch {
    return ""
  }
}

// False only for known fabrication/hoax/spam domains; true otherwise.
export function isValidSource(url: string): boolean {
  if (!url || !url.startsWith("http")) return false
  const host = domainOf(url)
  if (!host) return false
  for (const d of UNRELIABLE_DOMAINS) {
    if (host === d || host.endsWith(`.${d}`)) return false
  }
  return true
}

// Drop results whose URL fails isValidSource (keeps order).
export function filterSources(results: SearchResult[]): SearchResult[] {
  return results.filter(r => isValidSource(r.url))
}

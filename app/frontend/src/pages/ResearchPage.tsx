import { useState } from "react"
import { ExternalLink, FileText, Globe, Loader2, Search, Telescope } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { useResearchStream, type TraceEvent } from "@/hooks/useResearchStream"

type Level = "quick" | "deep_lookup" | "deep_search"
type Breadth = "clue" | "topic" | "article"

interface SourceRef { title: string; url: string }
interface QuickHit { title: string; url: string; snippet?: string }

interface LookupResponse {
  status: "success" | "error"
  level?: Level
  query?: string
  answer?: string
  content?: string
  context?: string
  sources?: SourceRef[]
  source_urls?: string[]
  source_count?: number
  results?: QuickHit[]
  message?: string
}

const LEVELS: { value: Level; label: string; hint: string; icon: typeof Search }[] = [
  { value: "quick", label: "Quick", hint: "Raw web hits, no LLM — seconds.", icon: Search },
  { value: "deep_lookup", label: "Deep look-up", hint: "Grounded, cited answer to one question — ~30s.", icon: Globe },
  { value: "deep_search", label: "Deep search", hint: "Multi-persona synthesized briefing — minutes.", icon: Telescope },
]

const BREADTHS: { value: Breadth; label: string }[] = [
  { value: "clue", label: "Clue (narrow)" },
  { value: "topic", label: "Topic (medium)" },
  { value: "article", label: "Article (broad)" },
]

const LEVEL_LABELS: Record<Level, string> = {
  quick: "Quick",
  deep_lookup: "Deep look-up",
  deep_search: "Deep search",
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

function SourceList({ sources }: { sources: SourceRef[] }) {
  if (sources.length === 0) return null
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-muted-foreground">Sources ({sources.length})</h3>
      <ol className="space-y-1.5">
        {sources.map((s, i) => (
          <li key={`${s.url}-${i}`} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5 shrink-0 font-mono text-xs text-muted-foreground">[{i + 1}]</span>
            <a
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group inline-flex min-w-0 items-baseline gap-1.5 text-primary underline-offset-4 hover:underline"
            >
              <span className="truncate">{s.title || hostOf(s.url)}</span>
              <ExternalLink className="size-3 shrink-0 self-center opacity-60 group-hover:opacity-100" />
            </a>
          </li>
        ))}
      </ol>
    </div>
  )
}

export function ResearchPage() {
  const [query, setQuery] = useState("")
  const [level, setLevel] = useState<Level>("deep_lookup")
  const [breadth, setBreadth] = useState<Breadth>("topic")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<LookupResponse | null>(null)

  // Live SSE trace for the deep tiers; quick stays a plain POST.
  const stream = useResearchStream<LookupResponse>()

  const activeLevel = LEVELS.find(l => l.value === level)!

  // Plain POST flow — used by the quick tier and as a fallback when streaming is
  // unavailable or fails before delivering a result.
  async function runPost(q: string, lvl: Level, br: Breadth): Promise<void> {
    const body: { query: string; level: Level; breadth?: Breadth } = { query: q, level: lvl }
    if (lvl === "deep_search") body.breadth = br
    const res = await fetch("/api/research/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(600_000),
    })
    const data: LookupResponse = await res.json().catch(() => ({ status: "error" as const, message: res.statusText }))
    if (!res.ok || data.status === "error") {
      setError(data.message || res.statusText || "Research request failed.")
      setResult(null)
    } else {
      setResult(data)
    }
  }

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault()
    const q = query.trim()
    if (!q || loading) return
    setLoading(true)
    setError(null)
    setResult(null)
    stream.reset()
    try {
      // Deep tiers stream a live trace over SSE; fall back to POST if that fails.
      if (level === "deep_lookup" || level === "deep_search") {
        try {
          const data = await stream.start({
            query: q,
            level,
            breadth: level === "deep_search" ? breadth : undefined,
          })
          if (data.status === "error") {
            setError(data.message || "Research request failed.")
            setResult(null)
          } else {
            setResult(data)
          }
        } catch {
          // EventSource unsupported, errored, or closed without a result — fall back.
          stream.reset()
          await runPost(q, level, breadth)
        }
      } else {
        await runPost(q, level, breadth)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      void handleSubmit()
    }
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Telescope className="size-6" /> Research
        </h1>
        <p className="text-sm text-muted-foreground">Run the internet-lookup tiers against the open web.</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="research-query">Query</Label>
          <Textarea
            id="research-query"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question or describe what you want to research…"
            rows={3}
            disabled={loading}
            className="resize-y"
          />
          <p className="text-xs text-muted-foreground">Press Cmd/Ctrl + Enter to search.</p>
        </div>

        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1.5">
            <Label>Tier</Label>
            <Select value={level} onValueChange={(v) => setLevel(v as Level)} disabled={loading}>
              <SelectTrigger className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LEVELS.map((l) => {
                  const Icon = l.icon
                  return (
                    <SelectItem key={l.value} value={l.value}>
                      <Icon className="size-4" /> {l.label}
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
          </div>

          {level === "deep_search" && (
            <div className="space-y-1.5">
              <Label>Breadth</Label>
              <Select value={breadth} onValueChange={(v) => setBreadth(v as Breadth)} disabled={loading}>
                <SelectTrigger className="w-[170px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BREADTHS.map((b) => (
                    <SelectItem key={b.value} value={b.value}>{b.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <Button type="submit" disabled={loading || !query.trim()}>
            {loading ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Search className="mr-2 size-4" />}
            {loading ? "Researching…" : "Search"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{activeLevel.hint}</p>
      </form>

      {loading && stream.trace.length === 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-border/70 bg-card/80 p-4 text-sm text-muted-foreground">
          <Loader2 className="size-5 shrink-0 animate-spin" />
          <span>Researching{level !== "quick" ? " — deeper tiers can take from tens of seconds to a few minutes." : "…"}</span>
        </div>
      )}

      {stream.trace.length > 0 && (
        <TracePanel trace={stream.trace} active={loading} />
      )}

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
      )}

      {result && !loading && <ResultView result={result} />}
    </main>
  )
}

// Live SSE trace — appends each {"type":"think"|"progress"} event as it streams in.
function TracePanel({ trace, active }: { trace: TraceEvent[]; active: boolean }) {
  return (
    <div className="space-y-2 rounded-lg border border-border/70 bg-card/80 p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        {active ? (
          <Loader2 className="size-4 shrink-0 animate-spin" />
        ) : (
          <Telescope className="size-4 shrink-0" />
        )}
        <span>Live trace</span>
      </div>
      <ol className="space-y-1.5 text-sm">
        {trace.map((ev, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0 font-mono text-xs leading-5 text-muted-foreground">
              {ev.type === "think"
                ? (ev.icon || "•")
                : ev.pct != null
                  ? `${Math.round(ev.pct * 100)}%`
                  : "•"}
            </span>
            <span className="min-w-0">
              <span className="font-medium text-foreground">{ev.label ?? ev.stage ?? ev.type}</span>
              {(ev.detail || ev.msg) && (
                <span className="text-muted-foreground"> — {ev.detail ?? ev.msg}</span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function ResultView({ result }: { result: LookupResponse }) {
  const sources = result.sources ?? []
  const sourceCount = result.source_count ?? sources.length
  const level = result.level ?? "deep_lookup"

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span>Results</span>
          <Badge variant="secondary" className="capitalize">{LEVEL_LABELS[level] ?? level}</Badge>
          {sourceCount > 0 && (
            <Badge variant="outline">{sourceCount} source{sourceCount === 1 ? "" : "s"}</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {level === "quick" ? (
          <QuickResults results={result.results ?? []} />
        ) : level === "deep_search" ? (
          <>
            <BriefingBlock content={result.content ?? ""} />
            <SourceList sources={sources} />
          </>
        ) : (
          <>
            <AnswerBlock answer={result.answer ?? ""} />
            <SourceList sources={sources} />
          </>
        )}
      </CardContent>
    </Card>
  )
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-dashed border-border/70 p-4 text-sm text-muted-foreground">
      <FileText className="size-4 shrink-0" /> {children}
    </div>
  )
}

function QuickResults({ results }: { results: QuickHit[] }) {
  if (results.length === 0) return <EmptyHint>No results found for this query.</EmptyHint>
  return (
    <ul className="space-y-4">
      {results.map((hit, i) => (
        <li key={`${hit.url}-${i}`} className="space-y-1">
          <a
            href={hit.url}
            target="_blank"
            rel="noopener noreferrer"
            className="group inline-flex items-baseline gap-1.5 font-medium text-primary underline-offset-4 hover:underline"
          >
            <span>{hit.title || hostOf(hit.url)}</span>
            <ExternalLink className="size-3.5 shrink-0 self-center opacity-60 group-hover:opacity-100" />
          </a>
          <div className="text-xs text-muted-foreground">{hostOf(hit.url)}</div>
          {hit.snippet && <p className="text-sm text-muted-foreground">{hit.snippet}</p>}
        </li>
      ))}
    </ul>
  )
}

function AnswerBlock({ answer }: { answer: string }) {
  const trimmed = answer.trim()
  if (!trimmed || trimmed === "INSUFFICIENT_EVIDENCE") {
    return <EmptyHint>No grounded answer — the search did not surface enough evidence. Try rephrasing or a broader tier.</EmptyHint>
  }
  return <p className="whitespace-pre-wrap text-sm leading-relaxed">{trimmed}</p>
}

function BriefingBlock({ content }: { content: string }) {
  const trimmed = content.trim()
  if (!trimmed) {
    return <EmptyHint>No briefing was produced — not enough evidence was gathered. Try a different breadth or rephrasing.</EmptyHint>
  }
  return (
    <pre className={cn("whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-foreground")}>{trimmed}</pre>
  )
}

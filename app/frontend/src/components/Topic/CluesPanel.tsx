"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { ArrowRight, ChevronDown, ChevronRight, MessageSquarePlus, PencilLine, RefreshCw, Search, Trash2, Zap } from "lucide-react"
import { api } from "@/api/client"
import { CredibilityRing } from "../Common/CredibilityRing"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

import { Slider } from "@/components/ui/slider"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { usePipelineStore } from "@/stores/pipelineStore"

type Clue = any

const BIAS_OPTIONS = ["state_media", "propaganda", "selective_reporting", "unverified_source", "editorial_bias", "conflict_of_interest", "single_source", "outdated"]

function getCurrent(clue: Clue) {
  if (clue?.versions?.length) return clue.versions.find((v: any) => v.v === clue.current) ?? clue.versions[0]
  return clue
}

function getParties(clues: Clue[]) {
  return Array.from(new Set(clues.flatMap((clue) => getCurrent(clue)?.party_relevance ?? clue.party_relevance ?? []))).sort()
}

function getDomains(clues: Clue[]) {
  return Array.from(new Set(clues.flatMap((clue) => getCurrent(clue)?.domain_tags ?? clue.domain_tags ?? []))).sort()
}

function getTypes(clues: Clue[]) {
  return Array.from(new Set(clues.map((clue) => String(getCurrent(clue)?.clue_type ?? clue.clue_type ?? "UNKNOWN")))).sort()
}

function matchesQuery(clue: Clue, query: string) {
  if (!query) return true
  const current = getCurrent(clue)
  const haystack = [current?.title, current?.bias_corrected_summary, current?.summary, clue?.id].filter(Boolean).join(" ").toLowerCase()
  return haystack.includes(query.toLowerCase())
}

function clueMatchesFilters(clue: Clue, filters: { party: string; domain: string; type: string }) {
  const current = getCurrent(clue)
  const parties = current?.party_relevance ?? clue.party_relevance ?? []
  const domains = current?.domain_tags ?? clue.domain_tags ?? []
  const type = String(current?.clue_type ?? clue.clue_type ?? "")
  return (!filters.party || parties.includes(filters.party)) && (!filters.domain || domains.includes(filters.domain)) && (!filters.type || type === filters.type)
}

function safeText(value: unknown) {
  if (typeof value === "string") return value
  if (value == null) return ""
  return String(value)
}

function labelBias(flag: string) {
  return flag.replace(/_/g, " ")
}

const VERDICT_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  verified: { bg: "bg-emerald-500/10 border-emerald-500/30", text: "text-emerald-700 dark:text-emerald-400", label: "Verified" },
  disputed: { bg: "bg-amber-500/10 border-amber-500/30", text: "text-amber-700 dark:text-amber-400", label: "Disputed" },
  misleading: { bg: "bg-red-500/10 border-red-500/30", text: "text-red-700 dark:text-red-400", label: "Misleading" },
  unverifiable: { bg: "bg-zinc-500/10 border-zinc-500/30", text: "text-zinc-600 dark:text-zinc-400", label: "Unverifiable" },
  pending: { bg: "bg-blue-500/10 border-blue-500/30", text: "text-blue-700 dark:text-blue-400", label: "Pending" },
}

function VerdictBadge({ status, verdict }: { status: string; verdict?: string }) {
  const key = verdict ?? status
  const style = VERDICT_STYLES[key] ?? VERDICT_STYLES.pending
  return <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium", style.bg, style.text)}>{style.label}</span>
}

function getSourceUrls(current: any): string[] {
  if (current.raw_source?.urls?.length) return current.raw_source.urls
  const legacy = current.raw_source?.url || current.source_url || current.source_credibility?.origin_source?.url
  return legacy ? [legacy] : []
}

function getSourceOutlets(current: any): string[] {
  if (current.raw_source?.outlets?.length) return current.raw_source.outlets
  if (current.source_credibility?.origin_sources?.length) return current.source_credibility.origin_sources.map((s: any) => s.outlet).filter(Boolean)
  const legacy = current.source_credibility?.origin_source?.outlet
  return legacy ? [legacy] : []
}

function ClueCard({ clue, expanded, onToggleExpanded, onEdit, onSmartEdit, onDelete }: {
  clue: Clue
  expanded: boolean
  onToggleExpanded: () => void
  onEdit?: () => void
  onSmartEdit?: () => void
  onDelete?: () => void
}) {
  const current = getCurrent(clue)
  const credibility = Number(current.source_credibility?.score ?? 0)
  const relevance = Math.round(current.relevance_score ?? 0)
  const sourceUrls = getSourceUrls(current)
  const sourceOutlets = getSourceOutlets(current)
  const biasNotes = current.source_credibility?.notes
  const biasFlags = current.source_credibility?.bias_flags ?? []
  const keyPoints = current.key_points ?? []
  const timelineDate = safeText(current.timeline_date)
  const factCheck = current.fact_check
  const verdict = factCheck?.verdict ?? (clue.status === "verified" ? undefined : clue.status)

  return (
    <div className="rounded-lg border border-border bg-card transition-colors">
      <button className="flex w-full items-center gap-3 px-4 py-3 text-left" onClick={onToggleExpanded}>
        {expanded ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <CredibilityRing score={credibility} size={20} />
            <span className="truncate text-sm font-medium">{current.title}</span>
            <VerdictBadge status={clue.status} verdict={verdict} />
            <Badge variant="secondary">{current.clue_type ?? "UNKNOWN"}</Badge>
            <Badge variant="outline">Rel {relevance}</Badge>
          </div>
          {!expanded && (current.bias_corrected_summary || current.summary) && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{current.bias_corrected_summary || current.summary}</p>
          )}
        </div>
      </button>

      {expanded && (
        <div className="space-y-3 border-t border-border/60 px-4 pb-4 pt-4">
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{current.bias_corrected_summary || current.summary || "No summary provided."}</p>

          {factCheck && (
            <div className={cn("rounded-lg border p-3 space-y-2", VERDICT_STYLES[factCheck.verdict]?.bg ?? "bg-muted/50")}>
              <div className="flex items-center gap-2">
                <VerdictBadge status={clue.status} verdict={factCheck.verdict} />
                <span className="text-xs font-medium">Fact-Check Analysis</span>
              </div>
              {factCheck.bias_analysis && (
                <div><div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Bias Analysis</div><p className="text-xs text-muted-foreground mt-0.5">{factCheck.bias_analysis}</p></div>
              )}
              {factCheck.cui_bono && (
                <div><div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Cui Bono</div><p className="text-xs text-muted-foreground mt-0.5">{factCheck.cui_bono}</p></div>
              )}
              {factCheck.counter_evidence && factCheck.verdict !== "verified" && (
                <div><div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Counter-Evidence</div><p className="text-xs text-muted-foreground mt-0.5">{factCheck.counter_evidence}</p></div>
              )}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-border bg-background p-3">
              <div className="mb-1 text-xs text-muted-foreground">Credibility</div>
              <div className="flex items-center gap-2">
                <CredibilityRing score={credibility} size={32} />
                <span className="text-sm font-medium">{credibility}/100</span>
              </div>
            </div>
            <div className="rounded-lg border border-border bg-background p-3">
              <div className="mb-1 text-xs text-muted-foreground">Relevance</div>
              <div className="h-2 rounded-full bg-muted">
                <div className="h-2 rounded-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, relevance))}%` }} />
              </div>
              <div className="mt-1 text-xs tabular-nums text-muted-foreground">{relevance}/100</div>
            </div>
          </div>

          {keyPoints.length > 0 && (
            <div className="rounded-lg border border-border bg-background p-3">
              <div className="mb-1 text-xs text-muted-foreground">Key points</div>
              <ul className="list-disc space-y-1 pl-4 text-sm text-muted-foreground">{keyPoints.map((point: string, i: number) => <li key={i}>{point}</li>)}</ul>
            </div>
          )}

          <div className="flex flex-wrap gap-1.5">
            {(current.party_relevance ?? []).map((item: string) => <Badge key={item} variant="secondary">{item}</Badge>)}
            {(current.domain_tags ?? []).map((item: string) => <Badge key={item} variant="outline">{item}</Badge>)}
            {biasFlags.length > 0 && biasFlags.map((flag: string) => <Badge key={flag} variant="destructive" className="text-[10px]">{labelBias(flag)}</Badge>)}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {sourceOutlets.length > 0 && (
              <div className="rounded-lg border border-border bg-background p-3">
                <div className="text-xs text-muted-foreground">Sources ({sourceOutlets.length})</div>
                <div className="mt-1 space-y-0.5">{sourceOutlets.map((o: string, i: number) => <div key={i} className="text-sm">{o}</div>)}</div>
              </div>
            )}
            {sourceUrls.length > 0 && (
              <div className="rounded-lg border border-border bg-background p-3">
                <div className="text-xs text-muted-foreground">URLs ({sourceUrls.length})</div>
                <div className="mt-1 space-y-0.5">{sourceUrls.map((url: string, i: number) => <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="block truncate text-sm text-primary underline">{url}</a>)}</div>
              </div>
            )}
            {biasNotes && <div className="rounded-lg border border-border bg-background p-3"><div className="text-xs text-muted-foreground">Bias notes</div><div className="mt-1 text-sm text-muted-foreground">{biasNotes}</div></div>}
            {timelineDate && <div className="rounded-lg border border-border bg-background p-3"><div className="text-xs text-muted-foreground">Date</div><div className="mt-1 text-sm">{timelineDate}</div></div>}
          </div>

          {(onEdit || onSmartEdit || onDelete) && (
            <div className="flex flex-wrap gap-2">
              {onEdit && <Button variant="outline" size="sm" onClick={onEdit}><PencilLine className="size-4" /> Edit</Button>}
              {onSmartEdit && <Button variant="outline" size="sm" onClick={onSmartEdit}><ArrowRight className="size-4" /> Smart edit</Button>}
              {onDelete && <Button variant="destructive" size="sm" onClick={onDelete}><Trash2 className="size-4" /> Delete</Button>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}



function EditClueCard({ clue, onSave, onCancel }: { clue: Clue; onSave: (patch: Record<string, unknown>) => void; onCancel: () => void }) {
  const current = getCurrent(clue)
  const [draft, setDraft] = useState({ summary: current.bias_corrected_summary ?? current.summary ?? "", credibility: Number(current.source_credibility?.score ?? 0), relevance: Number(current.relevance_score ?? 0), bias_flags: [...(current.source_credibility?.bias_flags ?? [])] })

  useEffect(() => {
    setDraft({ summary: current.bias_corrected_summary ?? current.summary ?? "", credibility: Number(current.source_credibility?.score ?? 0), relevance: Number(current.relevance_score ?? 0), bias_flags: [...(current.source_credibility?.bias_flags ?? [])] })
  }, [current.bias_corrected_summary, current.relevance_score, current.source_credibility?.bias_flags, current.source_credibility?.score, current.summary])

  const toggleBias = (flag: string) => setDraft((prev) => ({ ...prev, bias_flags: prev.bias_flags.includes(flag) ? prev.bias_flags.filter((item) => item !== flag) : [...prev.bias_flags, flag] }))

  return <Card className="border-border bg-card">
    <CardHeader><CardTitle className="text-base">Edit clue</CardTitle><CardDescription>Update summary, credibility, relevance, and bias flags.</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      <div className="space-y-2"><div className="flex items-center justify-between text-sm"><span>Credibility</span><span>{draft.credibility}</span></div><Slider value={[draft.credibility]} min={0} max={100} onValueChange={([value]) => setDraft((prev) => ({ ...prev, credibility: value ?? prev.credibility }))} /></div>
      <div className="space-y-2"><div className="flex items-center justify-between text-sm"><span>Relevance</span><span>{draft.relevance}</span></div><Slider value={[draft.relevance]} min={0} max={100} onValueChange={([value]) => setDraft((prev) => ({ ...prev, relevance: value ?? prev.relevance }))} /></div>
      <div className="space-y-2"><div className="text-sm">Bias flags</div><div className="flex flex-wrap gap-2">{BIAS_OPTIONS.map((flag) => <Button key={flag} type="button" variant={draft.bias_flags.includes(flag) ? "default" : "outline"} size="sm" onClick={() => toggleBias(flag)}>{labelBias(flag)}</Button>)}</div></div>
      <div className="space-y-2"><div className="text-sm">Summary</div><Textarea value={draft.summary} onChange={(e) => setDraft((prev) => ({ ...prev, summary: e.target.value }))} className="min-h-28" /></div>
      <div className="flex gap-2"><Button onClick={() => onSave({ bias_corrected_summary: draft.summary, credibility_score: draft.credibility, relevance_score: draft.relevance, bias_flags: draft.bias_flags })}>Save</Button><Button variant="outline" onClick={onCancel}>Cancel</Button></div>
    </CardContent>
  </Card>
}

const ACTION_CYCLE: Record<string, string> = { merge: "keep", keep: "delete", delete: "merge" }
const ACTION_STYLE: Record<string, string> = {
  merge: "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-400",
  keep: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  delete: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400",
}
const CONSOLIDATION_STYLE: Record<string, string> = {
  dedup: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400",
  consolidate: "border-purple-500/40 bg-purple-500/10 text-purple-700 dark:text-purple-400",
}

function CleanupReviewDialog({ open, groups, originalCount, onGroupsChange, onApply, onCancel, applying }: {
  open: boolean
  groups: any[]
  originalCount: number
  onGroupsChange: (groups: any[]) => void
  onApply: () => void
  onCancel: () => void
  applying: boolean
}) {
  const mergeCount = groups.filter(g => g.action === "merge").length
  const deleteCount = groups.filter(g => g.action === "delete").length
  const keepCount = groups.filter(g => g.action === "keep").length
  const finalCount = keepCount + mergeCount

  const cycleAction = (groupId: string) => {
    onGroupsChange(groups.map(g => g.group_id === groupId ? { ...g, action: ACTION_CYCLE[g.action] ?? "keep" } : g))
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !applying) onCancel() }}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-2xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>Review Cleanup</DialogTitle>
          <DialogDescription>
            {originalCount} clues → {finalCount} after cleanup.
            {mergeCount > 0 && ` ${mergeCount} merge${mergeCount !== 1 ? "s" : ""}.`}
            {deleteCount > 0 && ` ${deleteCount} deletion${deleteCount !== 1 ? "s" : ""}.`}
            {" "}Click an action badge to cycle it.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto space-y-2 pr-1">
          {groups.map((g) => (
            <div key={g.group_id} className="rounded-lg border border-border bg-card p-3 space-y-1.5">
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  onClick={() => cycleAction(g.group_id)}
                  className={cn("shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors", ACTION_STYLE[g.action])}
                >
                  {g.action}
                </button>
                {g.action === "merge" && g.consolidation_type && (
                  <span className={cn("shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium", CONSOLIDATION_STYLE[g.consolidation_type])}>
                    {g.consolidation_type}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium leading-snug">{g.merged_title}</div>
                  {g.reason && <div className="text-xs text-muted-foreground mt-0.5">{g.reason}</div>}
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {(g.source_clue_ids ?? []).map((id: string) => (
                  <span key={id} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{id}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={onCancel} disabled={applying}>Cancel</Button>
          <Button onClick={onApply} disabled={applying}>{applying ? "Applying…" : "Apply"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function BulkImportDialog({ open, onOpenChange, onStart }: { open: boolean; onOpenChange: (open: boolean) => void; onStart: (content: string) => Promise<void> }) {
  const [content, setContent] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleImport = async () => {
    setBusy(true)
    setError(null)
    try {
      await onStart(content)
      setContent("")
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bulk import failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o) }}>
      <DialogContent className="flex max-h-[90vh] flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>Bulk import clues</DialogTitle>
          <DialogDescription>Paste research notes, article text, or URLs. Each chunk will be verified with web search and fact-checked.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Textarea value={content} onChange={(e) => setContent(e.target.value)} className="min-h-64 resize-none" placeholder="Paste text, URLs, or notes here..." disabled={busy} />
        </div>
        {error && <p className="shrink-0 text-sm text-destructive">{error}</p>}
        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button disabled={busy || !content.trim()} onClick={() => void handleImport()}>{busy ? "Starting…" : "Import"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface CluesPanelProps { topicId: string; version?: number; isCurrentVersion?: boolean }

export function CluesPanel({ topicId, version, isCurrentVersion = true }: CluesPanelProps) {
  const [clues, setClues] = useState<Clue[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [filters, setFilters] = useState({ party: "all", domain: "all", type: "all" })
  const [editingClue, setEditingClue] = useState<Clue | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [researchError] = useState<string | null>(null)
  const [cleanupState, setCleanupState] = useState<"idle" | "proposing" | "review" | "applying">("idle")
  const [cleanupGroups, setCleanupGroups] = useState<any[]>([])
  const [cleanupOriginalCount, setCleanupOriginalCount] = useState(0)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Clue | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [smartEditClue, setSmartEditClue] = useState<Clue | null>(null)
  const [smartEditFeedback, setSmartEditFeedback] = useState("")
  const [smartEditBusy, setSmartEditBusy] = useState(false)
  const [smartAddOpen, setSmartAddOpen] = useState(false)
  const [smartAddQuery, setSmartAddQuery] = useState("")
  const [smartAddBusy, setSmartAddBusy] = useState(false)
  const startOp = usePipelineStore((s) => s.startOperation)
  const finishOp = usePipelineStore((s) => s.finishOperation)
  const readOnly = !isCurrentVersion


  const load = useCallback(async () => { setLoading(true); setError(null); try { setClues(await api.clues.list(topicId, version)) } catch (err) { setError(err instanceof Error ? err.message : "Failed to load clues") } finally { setLoading(false) } }, [topicId, version])
  useEffect(() => { void load() }, [load])

  // Reload clues when bulk-import, evidence-update, or cleanup completes
  const lastStageComplete = usePipelineStore((s) => {
    const items = s.sessions[topicId]?.items
    if (!items?.length) return null
    const last = items[items.length - 1]
    return last?.type === "stage_complete" ? `${last.stage}:${last.id}` : null
  })
  useEffect(() => {
    if (
      lastStageComplete?.startsWith("bulk_import:") ||
      lastStageComplete?.startsWith("evidence_update:") ||
      lastStageComplete?.startsWith("cleanup:")
    ) {
      void load()
    }
  }, [lastStageComplete, load])

  const options = useMemo(() => ({ parties: getParties(clues), domains: getDomains(clues), types: getTypes(clues) }), [clues])
  const filtered = useMemo(() => clues.filter((clue) => clueMatchesFilters(clue, { party: filters.party === "all" ? "" : filters.party, domain: filters.domain === "all" ? "" : filters.domain, type: filters.type === "all" ? "" : filters.type }) && matchesQuery(clue, search.trim())), [clues, filters, search])
  const clueCount = clues.length

  const saveClue = async (patch: Record<string, unknown>) => {
    if (!editingClue) return
    try { const updated = await api.clues.update(topicId, editingClue.id, patch); setClues((prev) => prev.map((item) => item.id === editingClue.id ? updated : item)); setEditingClue(null) } catch (err) { setError(err instanceof Error ? err.message : "Failed to save clue") }
  }

  const handleSmartEdit = async () => {
    if (!smartEditClue || !smartEditFeedback.trim()) return
    setSmartEditBusy(true)
    setSmartEditClue(null)
    startOp(topicId, "smart-edit", `Smart edit: ${getCurrent(smartEditClue).title}`)
    try {
      const updated = await api.clues.smartEdit(topicId, smartEditClue.id, smartEditFeedback.trim())
      setClues((prev) => prev.map((item) => item.id === smartEditClue.id ? updated : item))
      setSmartEditFeedback("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Smart-edit failed")
    } finally {
      finishOp()
      setSmartEditBusy(false)
    }
  }

  const startCleanup = async () => {
    setCleanupState("proposing"); setError(null)
    try {
      await api.clues.cleanupStart(topicId)
      const poll = setInterval(async () => {
        try {
          const status = await api.clues.cleanupStatus(topicId)
          if (status.status === "done") {
            clearInterval(poll)
            setCleanupGroups(status.groups ?? [])
            setCleanupOriginalCount(status.original_count ?? 0)
            setCleanupState("review")
          } else if (status.status === "error") {
            clearInterval(poll)
            setError(status.error ?? "Cleanup failed")
            setCleanupState("idle")
          }
        } catch { clearInterval(poll); setCleanupState("idle") }
      }, 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cleanup failed")
      setCleanupState("idle")
    }
  }

  const applyCleanup = async () => {
    setCleanupState("applying")
    startOp(topicId, "cleanup", "Cleanup: fact-checking merged clues…")
    try {
      await api.clues.cleanupApply(topicId, cleanupGroups)
      setCleanupState("idle")
      // OperationModal listens for stage_complete: cleanup and calls onComplete which triggers reload
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cleanup apply failed")
      finishOp()
      setCleanupState("idle")
    }
  }

  const handleBulkImport = async (content: string) => {
    startOp(topicId, "bulk-import", "Bulk Import: extracting & fact-checking")
    await api.clues.bulkImportStart(topicId, content)
    // OperationModal listens for stage_complete and calls onComplete which triggers load()
  }

  const handleUpdateEvidence = async () => {
    if (updateBusy) return
    setUpdateBusy(true)
    setError(null)
    startOp(topicId, "evidence-update", "Updating Evidence: checking for new developments")
    try {
      await api.clues.updateAllStart(topicId)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Evidence update failed")
      finishOp()
    } finally {
      setUpdateBusy(false)
    }
  }

  const handleSmartAdd = async () => {
    if (!smartAddQuery.trim()) return
    setSmartAddBusy(true); setSmartAddOpen(false); setError(null)
    startOp(topicId, "smart-add", `Research: ${smartAddQuery.slice(0, 40)}`)
    try {
      const result = await api.clues.smartAdd(topicId, smartAddQuery.trim())
      await load()
      setSmartAddQuery("")
      if (result.imported === 0) setError("No clues found for that query. Try a different search.")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Smart add failed")
    } finally {
      finishOp()
      setSmartAddBusy(false)
    }
  }

  return <div className="space-y-4 text-foreground">
    {readOnly && (
      <div className="flex items-center gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-2.5 text-sm text-blue-400">
        Viewing evidence from v{version}. Switch to the current version to edit.
      </div>
    )}
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm lg:flex-row lg:items-end lg:justify-between">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">Evidence</h2>
          <Badge variant="secondary">{clueCount}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">Search, filter, inspect, and refine clues.</p>
      </div>
      {!readOnly && (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setSmartAddOpen(true)} disabled={smartAddBusy}><Search className="size-4" /> Smart Add</Button>
          <Button variant="outline" onClick={() => setBulkOpen(true)}><MessageSquarePlus className="size-4" /> Bulk import</Button>
          <Button variant="outline" onClick={() => void handleUpdateEvidence()} disabled={updateBusy}><Zap className="size-4" /> Update Evidence</Button>
          <Button variant="outline" onClick={() => void startCleanup()} disabled={cleanupState !== "idle"}><RefreshCw className={cn("size-4", cleanupState === "proposing" && "animate-spin")} />{cleanupState === "proposing" ? "Analyzing…" : "Cleanup"}</Button>
        </div>
      )}
    </div>

    <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-5">
      <div className="relative xl:col-span-2">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search evidence" className="pl-9" />
      </div>
      <Select value={filters.party} onValueChange={(value) => setFilters((prev) => ({ ...prev, party: value }))}><SelectTrigger><SelectValue placeholder="Party" /></SelectTrigger><SelectContent><SelectItem value="all">All parties</SelectItem>{options.parties.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent></Select>
      <Select value={filters.domain} onValueChange={(value) => setFilters((prev) => ({ ...prev, domain: value }))}><SelectTrigger><SelectValue placeholder="Domain" /></SelectTrigger><SelectContent><SelectItem value="all">All domains</SelectItem>{options.domains.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent></Select>
      <Select value={filters.type} onValueChange={(value) => setFilters((prev) => ({ ...prev, type: value }))}><SelectTrigger><SelectValue placeholder="Type" /></SelectTrigger><SelectContent><SelectItem value="all">All types</SelectItem>{options.types.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent></Select>
    </div>

    {researchError && <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{researchError}</div>}
    {error && <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>}

    {loading ? (
      <div className="py-10 text-center text-sm text-muted-foreground">Loading clues...</div>
    ) : filtered.length === 0 ? (
      <Card className="border-dashed"><CardContent className="py-10 text-center text-sm text-muted-foreground">{clues.length === 0 ? "No clues yet. Use Bulk import or Research to add evidence." : "No clues match the current filters."}</CardContent></Card>
    ) : (
      <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-4">
        {filtered.map((clue) => <ClueCard key={clue.id} clue={clue} expanded={expandedId === clue.id} onToggleExpanded={() => setExpandedId(expandedId === clue.id ? null : clue.id)} onEdit={readOnly ? undefined : () => setEditingClue(clue)} onSmartEdit={readOnly ? undefined : () => { setSmartEditClue(clue); setSmartEditFeedback("") }} onDelete={readOnly ? undefined : () => setDeleteTarget(clue)} />)}
      </div>
    )}

    <Dialog open={Boolean(smartEditClue)} onOpenChange={(open) => !open && setSmartEditClue(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Smart edit</DialogTitle>
          <DialogDescription>Give feedback for {smartEditClue ? getCurrent(smartEditClue).title : ""}.</DialogDescription>
        </DialogHeader>
        <Textarea value={smartEditFeedback} onChange={(e) => setSmartEditFeedback(e.target.value)} placeholder="What should change?" className="min-h-28" />
        <DialogFooter>
          <Button variant="outline" onClick={() => setSmartEditClue(null)}>Cancel</Button>
          <Button onClick={() => void handleSmartEdit()} disabled={!smartEditFeedback.trim() || smartEditBusy}>{smartEditBusy ? "Applying..." : "Apply"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {editingClue && <Dialog open={!!editingClue} onOpenChange={(open) => !open && setEditingClue(null)}><DialogContent className="sm:max-w-2xl"><DialogHeader><DialogTitle>Edit clue</DialogTitle><DialogDescription>Update summary, credibility, relevance, and bias flags.</DialogDescription></DialogHeader><EditClueCard clue={editingClue} onSave={saveClue} onCancel={() => setEditingClue(null)} /></DialogContent></Dialog>}
    {deleteTarget && <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}><DialogContent><DialogHeader><DialogTitle>Delete clue?</DialogTitle><DialogDescription>This action cannot be undone.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button><Button variant="destructive" onClick={async () => { if (!deleteTarget) return; try { await api.clues.delete(topicId, deleteTarget.id); setClues((prev) => prev.filter((item) => item.id !== deleteTarget.id)); setDeleteTarget(null) } catch (err) { setError(err instanceof Error ? err.message : "Failed to delete clue") } }}>Delete</Button></DialogFooter></DialogContent></Dialog>}
    <BulkImportDialog open={bulkOpen} onOpenChange={setBulkOpen} onStart={handleBulkImport} />
    <CleanupReviewDialog
      open={cleanupState === "review"}
      groups={cleanupGroups}
      originalCount={cleanupOriginalCount}
      onGroupsChange={setCleanupGroups}
      onApply={() => void applyCleanup()}
      onCancel={() => setCleanupState("idle")}
      applying={cleanupState === "applying"}
    />
    <Dialog open={smartAddOpen} onOpenChange={setSmartAddOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Smart Add Evidence</DialogTitle>
          <DialogDescription>Enter a topic, fact, or question. The system will search the web, extract relevant clues, and fact-check them.</DialogDescription>
        </DialogHeader>
        <Input value={smartAddQuery} onChange={(e) => setSmartAddQuery(e.target.value)} placeholder='e.g. "ECB rate decision March 2026"' onKeyDown={(e) => { if (e.key === "Enter" && smartAddQuery.trim()) void handleSmartAdd() }} />
        <DialogFooter>
          <Button variant="outline" onClick={() => setSmartAddOpen(false)}>Cancel</Button>
          <Button onClick={() => void handleSmartAdd()} disabled={!smartAddQuery.trim() || smartAddBusy}>{smartAddBusy ? "Searching..." : "Search & Add"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
}

import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertCircle, ChevronDown, ChevronRight, Pencil, Plus, Search, SplitSquareVertical, Trash2, Users } from "lucide-react"
import { api } from "@/api/client"
import { usePipelineStore } from "@/stores/pipelineStore"
import { RadarChart } from "@/components/Common/RadarChart"
import { ConfirmationBanner } from "@/components/Topic/ConfirmationBanner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

type PartyWeightFactors = Record<string, number>

type Party = {
  id: string
  name: string
  type?: string
  weight?: number
  weight_factors?: PartyWeightFactors
  agenda?: string
  means?: string[] | string
  stance?: string
  vulnerabilities?: string[] | string
  circle?: { visible?: string[]; shadow?: string[] } | string[] | string
  description?: string
  weight_evidence?: Record<string, string>
  [key: string]: unknown
}

type EditableField = "name" | "type" | "agenda" | "means" | "stance" | "vulnerabilities" | "circle"

const AXIS_KEYS = ["military_capacity", "economic_control", "information_control", "international_support", "internal_legitimacy"] as const

function computePentagonScore(factors: PartyWeightFactors): number {
  const s = AXIS_KEYS.map(k => Math.max(0, Math.min(100, factors[k] ?? 0)))
  const sin72 = Math.sin((2 * Math.PI) / 5)
  let area = 0
  for (let i = 0; i < 5; i++) area += s[i] * s[(i + 1) % 5]
  area *= 0.5 * sin72
  const maxArea = 0.5 * sin72 * 5 * 100 * 100
  return Math.round(100 * area / maxArea)
}

const DIMENSION_LABELS: Record<string, string> = {
  military_capacity: "Military",
  economic_control: "Economic",
  information_control: "Information",
  international_support: "International",
  internal_legitimacy: "Legitimacy",
}

function asText(value: unknown) {
  if (Array.isArray(value)) return value.join(", ")
  if (value && typeof value === "object") return JSON.stringify(value)
  return typeof value === "string" ? value : ""
}

function parseArray(value: string) {
  return value.split(/\n|,/).map((item) => item.trim()).filter(Boolean)
}

function formatType(value?: string) {
  return value ? value.replace(/_/g, " ") : "Unknown"
}

function weightValue(party: Party) {
  return typeof party.weight === "number" ? party.weight : Number(party.weight ?? 0)
}

function safeWeightFactors(party: Party) {
  const factors = party.weight_factors ?? {}
  const keys = Object.keys(factors)
  if (keys.length === 5) return factors
  return {
    military_capacity: 0,
    economic_control: 0,
    information_control: 0,
    international_support: 0,
    internal_legitimacy: 0,
    ...factors,
  }
}

function bannerMessage(count: number) {
  return `Review ${count} parties before continuing analysis.`
}

function parseCircle(value: unknown): { visible: string[]; shadow: string[] } {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    return {
      visible: Array.isArray(obj.visible) ? obj.visible.map(String) : [],
      shadow: Array.isArray(obj.shadow) ? obj.shadow.map(String) : [],
    }
  }
  if (Array.isArray(value)) return { visible: value.map(String), shadow: [] }
  if (typeof value === "string" && value.trim()) return { visible: [value], shadow: [] }
  return { visible: [], shadow: [] }
}

function CircleDisplay({ value }: { value: unknown }) {
  const circle = parseCircle(value)
  return (
    <div className="space-y-2 text-sm">
      <div>
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Visible</span>
        {circle.visible.length > 0 ? (
          <ul className="mt-1 list-inside list-disc space-y-0.5 text-foreground">
            {circle.visible.map((item, i) => <li key={i}>{item}</li>)}
          </ul>
        ) : (
          <p className="mt-1 text-muted-foreground">—</p>
        )}
      </div>
      <div>
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Shadow</span>
        {circle.shadow.length > 0 ? (
          <ul className="mt-1 list-inside list-disc space-y-0.5 text-foreground">
            {circle.shadow.map((item, i) => <li key={i}>{item}</li>)}
          </ul>
        ) : (
          <p className="mt-1 text-muted-foreground">—</p>
        )}
      </div>
    </div>
  )
}

function CircleEditor({ value, onChange }: { value: unknown; onChange: (circle: { visible: string[]; shadow: string[] }) => void }) {
  const circle = parseCircle(value)
  return (
    <div className="space-y-3">
      <div>
        <Label className="text-xs text-muted-foreground">Visible (one per line)</Label>
        <Textarea value={circle.visible.join("\n")} onChange={(e) => onChange({ ...circle, visible: e.target.value.split("\n").filter(Boolean) })} className="mt-1 min-h-20" placeholder="Known allies, public partners..." />
      </div>
      <div>
        <Label className="text-xs text-muted-foreground">Shadow (one per line)</Label>
        <Textarea value={circle.shadow.join("\n")} onChange={(e) => onChange({ ...circle, shadow: e.target.value.split("\n").filter(Boolean) })} className="mt-1 min-h-20" placeholder="Covert supporters, proxy actors..." />
      </div>
    </div>
  )
}

function FieldValue({ field, value }: { field: string; value: unknown }) {
  if (field === "circle") return <CircleDisplay value={value} />
  return <div className="whitespace-pre-wrap text-sm text-foreground">{asText(value) || "—"}</div>
}

function PartyFieldEditor({ field, value, onChange, onCircleChange }: { field: EditableField; value: unknown; onChange: (value: string) => void; onCircleChange?: (circle: { visible: string[]; shadow: string[] }) => void }) {
  if (field === "circle" && onCircleChange) return <CircleEditor value={value} onChange={onCircleChange} />
  if (field === "means" || field === "vulnerabilities") {
    return <Textarea value={asText(value)} onChange={(e) => onChange(e.target.value)} className="min-h-24" />
  }
  return <Input value={asText(value)} onChange={(e) => onChange(e.target.value)} />
}

function PartyCard({
  party,
  expanded,
  selected,
  editing,
  draft,
  onToggleExpanded,
  onToggleSelected,
  onStartEdit,
  onDraftChange,
  onSave,
  onCancel,
  onSmartEdit,
  onSplit,
  onDelete,
}: {
  party: Party
  expanded: boolean
  selected: boolean
  editing: boolean
  draft: Partial<Party>
  onToggleExpanded: () => void
  onToggleSelected: () => void
  onStartEdit: () => void
  onDraftChange: (patch: Partial<Party>) => void
  onSave: () => void
  onCancel: () => void
  onSmartEdit: () => void
  onSplit: () => void
  onDelete: () => void
}) {
  const factors = safeWeightFactors(party)
  const sortedFactors = Object.entries(factors).slice(0, 5)

  return (
    <div className={cn("rounded-lg border border-border bg-card transition-colors", selected && "ring-2 ring-primary/40")}>
      <button className="flex w-full items-center gap-3 px-4 py-3 text-left" onClick={onToggleExpanded}>
        <input type="checkbox" checked={selected} onChange={(e) => { e.stopPropagation(); onToggleSelected() }} onClick={(e) => e.stopPropagation()} className="size-4 shrink-0 rounded border-border" />
        {expanded ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{party.name}</span>
            <Badge variant="outline" className="shrink-0">{formatType(party.type)}</Badge>
            <Badge className="shrink-0 tabular-nums">{Math.round(editing && draft.weight !== undefined ? (draft.weight as number) : weightValue(party))}</Badge>
          </div>
          {!expanded && party.description && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{party.description}</p>
          )}
        </div>
      </button>

      {expanded && (
        <div className="space-y-4 border-t border-border/60 px-4 pb-4 pt-4">
          {party.description && <p className="text-sm text-muted-foreground">{party.description}</p>}

          <div className="flex flex-wrap gap-2">
            {!editing && <Button variant="outline" size="sm" onClick={onStartEdit}><Pencil className="size-4" /> Edit</Button>}
            <Button variant="outline" size="sm" onClick={onSmartEdit}><Pencil className="size-4" /> Smart edit</Button>
            <Button variant="outline" size="sm" onClick={onSplit}><SplitSquareVertical className="size-4" /> Split</Button>
            <Button variant="destructive" size="sm" onClick={onDelete}><Trash2 className="size-4" /> Delete</Button>
          </div>

          <div className="grid gap-4 lg:grid-cols-[auto_1fr]">
            <div className="rounded-lg border border-border bg-background p-3">
              <RadarChart data={editing ? (safeWeightFactors({ weight_factors: draft.weight_factors ?? factors } as Party)) : factors} size={140} />
            </div>
            <div className="space-y-2">
              {sortedFactors.map(([key, value]) => {
                const evidence = party.weight_evidence?.[key]
                const draftFactors = draft.weight_factors as PartyWeightFactors | undefined
                const editingValue = draftFactors?.[key] ?? value
                return (
                  <div key={key} className="space-y-1">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>{DIMENSION_LABELS[key] ?? key}</span>
                      <span className="tabular-nums">{Math.round(editing ? editingValue : value)}</span>
                    </div>
                    {editing ? (
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={Math.round(editingValue)}
                        className="w-full accent-primary"
                        onChange={(e) => {
                          const newFactors = { ...(draftFactors ?? factors), [key]: Number(e.target.value) }
                          onDraftChange({ weight_factors: newFactors, weight: computePentagonScore(newFactors) })
                        }}
                      />
                    ) : (
                      <div className="h-2 rounded-full bg-muted">
                        <div className="h-2 rounded-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
                      </div>
                    )}
                    {evidence && <div className="text-[10px] leading-tight text-muted-foreground/70">{evidence}</div>}
                  </div>
                )
              })}
            </div>
          </div>

          <div className="space-y-3">
            <Separator />
            {(["name", "type", "agenda", "means", "stance", "vulnerabilities", "circle"] as EditableField[]).map((field) => (
              <div key={field} className="rounded-lg border border-border bg-background p-3">
                <Label className="mb-2 block capitalize text-muted-foreground">{field}</Label>
                {editing ? (
                  <PartyFieldEditor field={field} value={draft[field] ?? party[field]} onChange={(value) => onDraftChange({ [field]: field === "means" || field === "vulnerabilities" ? parseArray(value) : value })} onCircleChange={(circle) => onDraftChange({ circle })} />
                ) : (
                  <FieldValue field={field} value={party[field]} />
                )}
              </div>
            ))}
            {editing && (
              <div className="flex gap-2">
                <Button onClick={onSave}>Save</Button>
                <Button variant="outline" onClick={onCancel}>Cancel</Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

interface PartiesPanelProps {
  topicId: string
  status: string
  version?: number
  onApprove?: () => void
  approveLoading?: boolean
}

export function PartiesPanel({ topicId, status, version, onApprove, approveLoading }: PartiesPanelProps) {
  const startOp = usePipelineStore((s) => s.startOperation)
  const finishOp = usePipelineStore((s) => s.finishOperation)
  const [parties, setParties] = useState<Party[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [editingPartyId, setEditingPartyId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Partial<Party>>({})

  const [smartAddOpen, setSmartAddOpen] = useState(false)
  const [smartAddName, setSmartAddName] = useState("")
  const [smartEditParty, setSmartEditParty] = useState<Party | null>(null)
  const [smartEditFeedback, setSmartEditFeedback] = useState("")
  const [deleteParty, setDeleteParty] = useState<Party | null>(null)
  const [splitParty, setSplitParty] = useState<Party | null>(null)
  const [splitNames, setSplitNames] = useState(["", ""])
  const [mergeOpen, setMergeOpen] = useState(false)
  const [splitBusy, setSplitBusy] = useState(false)
  const [mergeBusy, setMergeBusy] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [search, setSearch] = useState("")
  const [filterType, setFilterType] = useState("all")
  const reviewMode = status === "review_parties"

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api.parties.list(topicId, version)
      setParties(Array.isArray(data) ? data : [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load parties")
    } finally {
      setLoading(false)
    }
  }, [topicId, version])

  useEffect(() => { void load() }, [load])

  const sortedParties = useMemo(() => [...parties].sort((a, b) => weightValue(b) - weightValue(a)), [parties])
  const filterOptions = useMemo(() => {
    const types = Array.from(new Set(parties.map((party) => formatType(party.type))))
    return { types }
  }, [parties])

  const visibleParties = useMemo(() => {
    const q = search.trim().toLowerCase()
    return sortedParties.filter((party) => {
      const matchesSearch = !q || [party.name, party.type, party.description, party.agenda, party.stance].filter(Boolean).some((value) => String(value).toLowerCase().includes(q))
      const matchesType = filterType === "all" || formatType(party.type) === filterType
      return matchesSearch && matchesType
    })
  }, [filterType, search, sortedParties])

  const updateParty = async (partyId: string, patch: Partial<Party>) => {
    const previous = parties
    setError(null)
    setParties((current) => current.map((party) => (party.id === partyId ? { ...party, ...patch } : party)))
    try {
      const updated = await api.parties.update(topicId, partyId, patch as Record<string, unknown>)
      setParties((current) => current.map((party) => (party.id === partyId ? { ...party, ...(updated ?? patch) } : party)))
      setEditingPartyId(null)
      setDraft({})
    } catch (err) {
      setParties(previous)
      setError(err instanceof Error ? err.message : "Failed to save party")
    }
  }

  const handleSmartAdd = async () => {
    if (!smartAddName.trim()) return
    setActionBusy(true)
    setSmartAddOpen(false)
    startOp(topicId, "smart-add", `Smart add: ${smartAddName.trim()}`)
    try {
      await api.parties.smartAdd(topicId, smartAddName.trim())
      await load()
      setSmartAddName("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Smart add failed")
    } finally {
      finishOp()
      setActionBusy(false)
    }
  }

  const handleSmartEdit = async () => {
    if (!smartEditParty || !smartEditFeedback.trim()) return
    setActionBusy(true)
    setSmartEditParty(null)
    startOp(topicId, "smart-edit", `Smart edit: ${smartEditParty.name}`)
    try {
      await api.parties.smartEdit(topicId, smartEditParty.id, smartEditFeedback.trim())
      await load()
      setSmartEditFeedback("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Smart edit failed")
    } finally {
      finishOp()
      setActionBusy(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteParty) return
    const previous = parties
    setActionBusy(true)
    try {
      await api.parties.delete(topicId, deleteParty.id)
      setParties((current) => current.filter((party) => party.id !== deleteParty.id))
      setDeleteParty(null)
      setSelectedIds((current) => {
        const next = new Set(current)
        next.delete(deleteParty.id)
        return next
      })
    } catch (err) {
      setParties(previous)
      setError(err instanceof Error ? err.message : "Delete failed")
    } finally {
      setActionBusy(false)
    }
  }

  const handleSplit = async () => {
    if (!splitParty) return
    setSplitBusy(true)
    const partyName = splitParty.name
    setSplitParty(null)
    startOp(topicId, "split", `Split: ${partyName}`)
    try {
      await api.parties.split(topicId, splitParty.id, splitNames.filter(Boolean).map((name) => ({ name })))
      await load()
      setSplitNames(["", ""])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Split failed")
    } finally {
      finishOp()
      setSplitBusy(false)
    }
  }

  const handleMerge = async () => {
    const sourceIds = Array.from(selectedIds)
    if (sourceIds.length < 2) return
    setMergeBusy(true)
    setMergeOpen(false)
    const names = sourceIds.map((id) => parties.find((party) => party.id === id)?.name).filter(Boolean).join(" + ")
    startOp(topicId, "merge", `Merge: ${names}`)
    try {
      await api.parties.merge(topicId, sourceIds, { name: names })
      setSelectedIds(new Set())
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Merge failed")
    } finally {
      finishOp()
      setMergeBusy(false)
    }
  }

  if (loading) {
    return <div className="py-10 text-center text-sm text-muted-foreground">Loading parties…</div>
  }

  return (
    <div className="space-y-4 text-foreground">
      {reviewMode && onApprove && (
        <ConfirmationBanner message={bannerMessage(parties.length)} detail="Review, split, merge, or correct parties before continuing." actionLabel="Continue Analysis" onConfirm={onApprove} loading={approveLoading} />
      )}

      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">Parties</h2>
            <Badge variant="secondary">{parties.length}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">Sorted by weight, with inline editing and AI-assisted operations.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setSmartAddOpen(true)}><Plus className="size-4" /> Smart add</Button>
          <Button variant="outline" onClick={() => setMergeOpen(true)} disabled={selectedIds.size < 2}><Users className="size-4" /> Merge selected</Button>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-[1fr_180px]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search parties" className="pl-9" />
        </div>
        <Select value={filterType} onValueChange={setFilterType}>
          <SelectTrigger className="w-full"><SelectValue placeholder="Filter type" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {filterOptions.types.map((type) => <SelectItem key={type} value={type}>{type}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="size-4" /> {error}
        </div>
      )}

      {visibleParties.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {parties.length === 0 ? "No parties yet. Use Smart add to generate the first profile." : "No parties match the current filters."}
          </CardContent>
        </Card>
      ) : (
        <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-4">
          {visibleParties.map((party) => {
            const isExpanded = expandedIds.has(party.id)
            const selected = selectedIds.has(party.id)
            return (
              <PartyCard
                key={party.id}
                party={party}
                expanded={isExpanded}
                selected={selected}
                editing={editingPartyId === party.id}
                draft={draft}
                onToggleExpanded={() => {
                  setExpandedIds((current) => {
                    const next = new Set(current)
                    if (next.has(party.id)) next.delete(party.id)
                    else next.add(party.id)
                    return next
                  })
                }}
                onToggleSelected={() => setSelectedIds((current) => {
                  const next = new Set(current)
                  if (next.has(party.id)) next.delete(party.id)
                  else next.add(party.id)
                  return next
                })}
                onStartEdit={() => {
                  setEditingPartyId(party.id)
                  setDraft({ ...party })
                }}
                onDraftChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
                onSave={() => { void updateParty(party.id, draft) }}
                onCancel={() => { setEditingPartyId(null); setDraft({}) }}
                onSmartEdit={() => { setSmartEditParty(party); setSmartEditFeedback("") }}
                onSplit={() => { setSplitParty(party); setSplitNames([`${party.name} (A)`, `${party.name} (B)`]) }}
                onDelete={() => setDeleteParty(party)}
              />
            )
          })}
        </div>
      )}



      <Dialog open={smartAddOpen} onOpenChange={setSmartAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Smart add party</DialogTitle>
            <DialogDescription>Enter a party name and let the backend generate the profile.</DialogDescription>
          </DialogHeader>
          <Input value={smartAddName} onChange={(e) => setSmartAddName(e.target.value)} placeholder="Party name" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSmartAddOpen(false)}>Cancel</Button>
            <Button onClick={() => void handleSmartAdd()} disabled={actionBusy}>{actionBusy ? "Adding..." : "Add"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(smartEditParty)} onOpenChange={(open) => !open && setSmartEditParty(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Smart edit</DialogTitle>
            <DialogDescription>Give feedback for {smartEditParty?.name}.</DialogDescription>
          </DialogHeader>
          <Textarea value={smartEditFeedback} onChange={(e) => setSmartEditFeedback(e.target.value)} placeholder="What should change?" className="min-h-28" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSmartEditParty(null)}>Cancel</Button>
            <Button onClick={() => void handleSmartEdit()} disabled={!smartEditFeedback.trim()}>Apply</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteParty)} onOpenChange={(open) => !open && setDeleteParty(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete party</DialogTitle>
            <DialogDescription>This will permanently remove {deleteParty?.name}.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteParty(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => void handleDelete()} disabled={actionBusy}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(splitParty)} onOpenChange={(open) => !open && setSplitParty(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Split party</DialogTitle>
            <DialogDescription>Propose the sub-parties to split {splitParty?.name} into.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {splitNames.map((name, index) => (
              <Input key={index} value={name} onChange={(e) => setSplitNames((current) => current.map((item, i) => (i === index ? e.target.value : item)))} placeholder={`Sub-party ${index + 1}`} />
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSplitParty(null)}>Cancel</Button>
            <Button onClick={() => void handleSplit()} disabled={splitBusy}>{splitBusy ? "Splitting..." : "Split"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={mergeOpen} onOpenChange={setMergeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Merge parties</DialogTitle>
            <DialogDescription>Merge {selectedIds.size} selected parties into one profile.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {Array.from(selectedIds).map((id) => (
              <div key={id} className="rounded-md border border-border px-3 py-2 text-sm">{parties.find((party) => party.id === id)?.name}</div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMergeOpen(false)}>Cancel</Button>
            <Button onClick={() => void handleMerge()} disabled={mergeBusy || selectedIds.size < 2}>{mergeBusy ? "Merging..." : "Merge"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

import { useEffect, useState } from "react"
import { api } from "@/api/client"
import { partyColor } from "@/utils/partyColor"
import { ConversationView } from "@/components/Forum/ConversationView"
import { ChevronDown, ChevronRight, X } from "lucide-react"

type Representative = {
  id: string
  party_id: string
  persona_title: string
  persona_prompt: string
  speaking_weight: number
  speaking_budget: { opening_statement: number; rebuttal: number; closing: number; minimum_floor: number }
}

type ForumSession = {
  session_id: string
  status: string
  rounds: { round: number; type: string; turns: any[] }[]
  scenarios: any[]
}

function RepChip({ rep, onClick }: { rep: Representative; onClick: () => void }) {
  const color = partyColor(rep.party_id)
  const initial = rep.persona_title.charAt(0).toUpperCase()

  return (
    <button
      className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-border/60 bg-card/60 hover:bg-card transition-colors text-left"
      onClick={onClick}
    >
      <div
        className="w-5 h-5 rounded-full shrink-0 flex items-center justify-center text-[9px] font-bold text-white"
        style={{ backgroundColor: color }}
      >
        {initial}
      </div>
      <span className="text-[11px] font-medium text-foreground truncate">{rep.persona_title}</span>
      <span
        className="text-[9px] font-medium tabular-nums px-1.5 py-0.5 rounded-full shrink-0 ml-auto"
        style={{ backgroundColor: `${color}20`, color }}
      >
        w{rep.speaking_weight}
      </span>
    </button>
  )
}

function RepDetailPopup({ rep, onClose }: { rep: Representative; onClose: () => void }) {
  const color = partyColor(rep.party_id)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative w-full max-w-md rounded-xl border border-border bg-card shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
          <div
            className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center text-sm font-bold text-white"
            style={{ backgroundColor: color }}
          >
            {rep.persona_title.charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-foreground">{rep.persona_title}</div>
            <div className="text-[11px] text-muted-foreground">{rep.party_id.replace(/_/g, " ")}</div>
          </div>
          <span
            className="text-xs font-medium tabular-nums px-2 py-0.5 rounded-full"
            style={{ backgroundColor: `${color}20`, color }}
          >
            weight {rep.speaking_weight}
          </span>
          <button className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted transition-colors" onClick={onClose}>
            <X className="size-4" />
          </button>
        </div>
        <div className="px-4 py-3 space-y-3 max-h-[60vh] overflow-y-auto">
          <p className="text-xs text-muted-foreground leading-relaxed">{rep.persona_prompt}</p>
          <div className="flex gap-4 text-[11px] text-muted-foreground tabular-nums pt-1 border-t border-border/40">
            <span>Opening: {rep.speaking_budget.opening_statement}w</span>
            <span>Rebuttal: {rep.speaking_budget.rebuttal}w</span>
            <span>Closing: {rep.speaking_budget.closing}w</span>
          </div>
        </div>
      </div>
    </div>
  )
}

export function ForumTab({ topicId, version }: { topicId: string; version?: number }) {
  const [reps, setReps] = useState<Representative[]>([])
  const [forum, setForum] = useState<ForumSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedRep, setSelectedRep] = useState<Representative | null>(null)
  const [showReps, setShowReps] = useState(true)

  useEffect(() => {
    setLoading(true)
    const versionParam = version ? `?version=${version}` : ""
    Promise.all([
      api.representatives.list(topicId, version).catch(() => []),
      fetch(`/api/topics/${topicId}/forum${versionParam}`).then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([r, f]) => {
      setReps(r)
      setForum(f)
    }).finally(() => setLoading(false))
  }, [topicId, version])

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading...</div>

  if (!reps.length && !forum) {
    return (
      <div className="rounded-xl border border-dashed border-border p-8 text-center bg-card">
        <div className="text-lg font-semibold text-foreground">Forum</div>
        <div className="mt-2 text-sm text-muted-foreground">Run Forum Prep to generate representative personas for the debate.</div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {reps.length > 0 && (
        <div>
          <button
            className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors mb-2"
            onClick={() => setShowReps(s => !s)}
          >
            {showReps ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            Representatives ({reps.length})
          </button>
          {showReps && (
            <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {reps.map(rep => (
                <RepChip key={rep.id} rep={rep} onClick={() => setSelectedRep(rep)} />
              ))}
            </div>
          )}
        </div>
      )}

      {forum ? (
        <ConversationView topicId={topicId} sessionId={forum.session_id} />
      ) : reps.length > 0 ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center bg-card">
          <div className="text-lg font-semibold text-foreground">Forum Debate</div>
          <div className="mt-2 text-sm text-muted-foreground">Representatives are ready. Run Forum to start the debate.</div>
        </div>
      ) : null}

      {selectedRep && <RepDetailPopup rep={selectedRep} onClose={() => setSelectedRep(null)} />}
    </div>
  )
}

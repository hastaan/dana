import { useEffect, useState } from "react"
import { X } from "lucide-react"

interface OriginSource { url: string; outlet: string; is_republication: boolean }

interface ClueVersion {
  v: number
  title: string
  bias_corrected_summary: string
  source_credibility: { score: number; notes: string; bias_flags: string[]; origin_sources?: OriginSource[]; origin_source?: OriginSource }
  relevance_score: number
  timeline_date: string
  key_points: string[]
}

interface Clue {
  id: string
  current: number
  versions: ClueVersion[]
}

export function ClueDetailSidebar({ topicId, clueId, onClose }: { topicId: string; clueId: string; onClose: () => void }) {
  const [clue, setClue] = useState<Clue | null>(null)

  useEffect(() => {
    fetch(`/api/topics/${topicId}/clues/${clueId}`)
      .then(r => r.json())
      .then(setClue)
      .catch(() => {})
  }, [topicId, clueId])

  const cur = clue?.versions.find(v => v.v === clue.current)

  return (
    <div className="fixed right-0 top-0 h-full w-80 bg-card border-l border-border shadow-xl z-50 flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <span className="font-mono text-sm text-primary">{clueId}</span>
        <button className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded hover:bg-muted" onClick={onClose}>
          <X className="size-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {!clue && <div className="text-muted-foreground text-sm">Loading...</div>}
        {cur && (
          <>
            <h3 className="text-sm font-semibold text-foreground">{cur.title}</h3>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{cur.timeline_date}</span>
              <span>·</span>
              <span className={`font-medium ${cur.source_credibility.score >= 80 ? "text-emerald-400" : cur.source_credibility.score >= 50 ? "text-yellow-400" : "text-red-400"}`}>
                credibility {cur.source_credibility.score}
              </span>
            </div>
            {cur.source_credibility.bias_flags.length > 0 && (
              <div className="flex gap-1 flex-wrap">
                {cur.source_credibility.bias_flags.map(f => (
                  <span key={f} className="text-[10px] bg-red-500/10 text-red-400 border border-red-500/20 px-1.5 py-0.5 rounded">{f}</span>
                ))}
              </div>
            )}
            <p className="text-sm text-foreground/80 leading-relaxed">{cur.bias_corrected_summary}</p>
            {(() => {
              const sources = cur.source_credibility.origin_sources ?? (cur.source_credibility.origin_source ? [cur.source_credibility.origin_source] : [])
              const outlets = sources.filter(s => s.outlet)
              if (!outlets.length) return null
              return (
                <p className="text-xs text-muted-foreground">
                  Sources: {outlets.map((s, i) => <span key={i} className="font-medium">{s.outlet}{i < outlets.length - 1 ? ", " : ""}</span>)}
                </p>
              )
            })()}
            {cur.key_points.length > 0 && (
              <div>
                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">Key points</p>
                <ul className="text-xs text-muted-foreground list-disc list-inside space-y-0.5">
                  {cur.key_points.map((kp, i) => <li key={i}>{kp}</li>)}
                </ul>
              </div>
            )}
            <p className="text-xs text-muted-foreground/60">{cur.source_credibility.notes}</p>
          </>
        )}
      </div>
    </div>
  )
}

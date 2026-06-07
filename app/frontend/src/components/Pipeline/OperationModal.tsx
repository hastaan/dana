import { useEffect, useRef } from "react"
import { AlertCircle, ChevronUp, CircleDot, Clock3, Lightbulb, Loader2, MessagesSquare, Search, Sparkles, TriangleAlert } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { useSSE } from "@/hooks/useSSE"
import { usePipelineStore, type PipelineFeedItem } from "@/stores/pipelineStore"

export function OperationModal({ onComplete }: { onComplete?: () => void } = {}) {
  const op = usePipelineStore((s) => s.activeOperation)
  const pushEvent = usePipelineStore((s) => s.pushEvent)
  const finishOp = usePipelineStore((s) => s.finishOperation)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Own SSE connection that activates whenever there's an active operation
  useSSE(op?.topicId ?? null, (event) => {
    if (op) pushEvent(op.topicId, event)
    if (event.type === "stage_complete" || event.type === "error") {
      setTimeout(() => { finishOp(); onComplete?.() }, 1500)
    }
  })

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
  }, [op?.events.length])

  if (!op) return null

  return (
    <Dialog open modal>
      <DialogContent className="max-w-lg gap-0 p-0 [&>button]:hidden" onPointerDownOutside={(e) => e.preventDefault()}>
        <DialogHeader className="flex flex-row items-center justify-between gap-3 border-b border-border/60 px-5 py-4">
          <div className="flex items-center gap-3">
            <Loader2 className="size-4 animate-spin text-primary" />
            <DialogTitle className="text-base">{op.label}</DialogTitle>
          </div>
          <Badge variant="secondary">{op.type}</Badge>
        </DialogHeader>

        <div ref={scrollRef} className="flex max-h-[60vh] min-h-48 flex-col gap-2 overflow-y-auto px-5 py-4">
          {op.events.length === 0 && (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              Waiting for events...
            </div>
          )}
          {op.events.map((item, i) => (
            <EventBlock key={item.id} item={item} latest={i === op.events.length - 1} />
          ))}
        </div>

        <div className="flex items-center gap-2 border-t border-border/60 px-5 py-3 text-xs text-muted-foreground">
          <ChevronUp className="size-3" />
          <span>{op.events.length} event{op.events.length !== 1 ? "s" : ""}</span>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function EventBlock({ item, latest }: { item: PipelineFeedItem; latest: boolean }) {
  const meta = eventMeta(item)
  const age = formatAge(item.ts)

  return (
    <div className={cn(
      "flex gap-3 rounded-lg border px-4 py-3 transition-all",
      latest ? "border-primary/40 bg-primary/5 shadow-sm" : "border-border/50 bg-card",
    )}>
      <div className={cn("mt-0.5 shrink-0", latest ? "text-primary" : "text-muted-foreground")}>
        {meta.icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className={cn("text-sm font-medium", latest && "text-primary")}>{meta.title}</span>
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{age}</span>
        </div>
        {meta.detail && (
          <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{meta.detail}</div>
        )}
      </div>
    </div>
  )
}

function eventMeta(item: PipelineFeedItem) {
  switch (item.type) {
    case "think": return { icon: <Sparkles size={14} />, title: item.label, detail: item.detail }
    case "progress": return { icon: <Clock3 size={14} />, title: `${item.stage} ${Math.round(item.pct)}%`, detail: item.msg }
    case "forum_turn": return { icon: <MessagesSquare size={14} />, title: "Forum turn", detail: stringifyTurn(item.turn) }
    case "clue_discovered": return { icon: <Lightbulb size={14} />, title: item.title, detail: `${item.source} - relevance ${Math.round(item.relevance)}` }
    case "stage_complete": return { icon: <CircleDot size={14} />, title: `Stage complete: ${item.stage}`, detail: undefined }
    case "error": return { icon: <TriangleAlert size={14} />, title: "Error", detail: item.message }
    case "weight_result": return { icon: <Search size={14} />, title: "Forum prep results", detail: item.parties.map(p => `${p.name} ${p.weight}`).join(" / ") }
    case "expert_assessment": return { icon: <Sparkles size={14} />, title: item.expert, detail: `${item.domain} - ${item.summary}` }
    case "verdict_content": return { icon: <AlertCircle size={14} />, title: "Verdict", detail: item.headline }
  }
}

function formatAge(ts: number) {
  const sec = Math.round((Date.now() - ts) / 1000)
  if (sec < 5) return "now"
  if (sec < 60) return `${sec}s ago`
  return `${Math.round(sec / 60)}m ago`
}

function stringifyTurn(turn: Record<string, unknown>) {
  return String(turn.statement ?? turn.content ?? turn.position ?? "Forum update")
}

import { useEffect, useMemo, useRef, useState } from "react"
import { AlertCircle, ChevronDown, ChevronRight, CircleDot, Clock3, Lightbulb, MessagesSquare, Play, RotateCcw, Search, Sparkles, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { useSSE } from "@/hooks/useSSE"
import { usePipelineStore, type PipelineFeedItem } from "@/stores/pipelineStore"

export type PipelineStage = "discovery" | "enrichment" | "forum_prep" | "forum" | "expert_council"

const STAGES: { key: PipelineStage; label: string }[] = [
  { key: "discovery", label: "Discovery" },
  { key: "enrichment", label: "Enrichment" },
  { key: "forum_prep", label: "Forum Prep" },
  { key: "forum", label: "Forum" },
  { key: "expert_council", label: "Scenario Scoring" },
]

export type PipelineAction = "discover" | "enrich" | "forum_prep" | "forum" | "score" | "analyze" | "reanalyze"

export type PipelineStatus = "draft" | "review_parties" | "review_enrichment" | "forum" | "expert_council" | "complete" | "stale" | string

interface Props {
  topicId: string | null
  status: PipelineStatus
  completedStages?: string[]
  active?: boolean
  onAction: (action: PipelineAction) => void | Promise<void>
  onStageComplete?: () => void
}

export function PipelineActivityFeed({ topicId, status, completedStages, active = false, onAction, onStageComplete }: Props) {
  const [collapsed, setCollapsed] = useState(false)
  const topicRef = useRef(topicId)
  const pushEvent = usePipelineStore((state) => state.pushEvent)
  const hasActiveOp = usePipelineStore((state) => state.activeOperation !== null)
  const session = usePipelineStore((state) => (topicId ? state.sessions[topicId] : undefined))
  const items = session?.items ?? []

  useEffect(() => {
    if (topicRef.current !== topicId) {
      topicRef.current = topicId
      setCollapsed(false)
    }
  }, [topicId])

  useSSE(active && topicId && !hasActiveOp ? topicId : null, (event) => {
    if (!topicId) return
    pushEvent(topicId, event)
    if (event.type === "stage_complete") onStageComplete?.()
  })



  const stageState = useMemo(() => {
    const completed = completedStages?.length
      ? new Set(completedStages as PipelineStage[])
      : stagesCompletedByStatus(status)
    const running = stageRunningByStatus(status)
    return STAGES.map(stage => {
      if (completed.has(stage.key)) return { ...stage, state: "done" as const }
      if (running === stage.key) return { ...stage, state: "running" as const }
      return { ...stage, state: "pending" as const }
    })
  }, [status, completedStages])

  const stageActions = useMemo(() => getStageActions(status, completedStages), [status, completedStages])

  const idle = !active && items.length === 0 && status === "draft"
  const minimized = collapsed

  return <Card className={cn("border-border/70 bg-card/80 shadow-none", minimized ? "sticky bottom-4 mx-4" : "mx-0")}> 
    <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 px-4 py-3">
      <div className="flex items-center gap-2">
        <CardTitle className="text-sm">Pipeline</CardTitle>
        <Badge variant={active ? "default" : "secondary"}>{active ? "Live" : "Idle"}</Badge>
      </div>
      <Button size="icon" variant="ghost" onClick={() => setCollapsed(v => !v)} aria-label={collapsed ? "Expand" : "Collapse"}>{collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}</Button>
    </CardHeader>
    {!minimized && <CardContent className="space-y-4 px-4 pb-4 pt-0">
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {stageState.map(stage => {
          const action = stageActions[stage.key]
          return <StageCard key={stage.key} label={stage.label} state={stage.state} action={action} onAction={onAction} />
        })}
      </div>
      <div className="max-h-[28rem] overflow-y-auto rounded-xl border border-border/60 bg-background p-3">
        <div className="flex flex-col-reverse gap-2">
          {items.length === 0 ? <div className="text-sm text-muted-foreground">{idle ? "Idle. Run Discovery to begin." : "Waiting for events..."}</div> : items.map(item => <FeedRow key={item.id} item={item} />)}
        </div>
      </div>
    </CardContent>}
  </Card>
}

type StageAction = { action: PipelineAction; label: string; variant: "run" | "rerun"; disabled: boolean; reason?: string }

function getStageActions(status: PipelineStatus, completedStages?: string[]): Record<PipelineStage, StageAction> {
  const completed = completedStages?.length
    ? new Set(completedStages as PipelineStage[])
    : stagesCompletedByStatus(status)
  const running = stageRunningByStatus(status)
  const isRunning = running !== null

  const discoveryDone = completed.has("discovery")
  const enrichmentDone = completed.has("enrichment")
  const forumPrepDone = completed.has("forum_prep")
  const forumDone = completed.has("forum")
  const allDone = completed.has("expert_council")

  return {
    discovery: {
      action: "discover",
      label: discoveryDone ? "Re-run" : "Run",
      variant: discoveryDone ? "rerun" : "run",
      disabled: isRunning,
      reason: isRunning ? "Pipeline is running" : undefined,
    },
    enrichment: {
      action: "enrich",
      label: enrichmentDone ? "Re-run" : "Run",
      variant: enrichmentDone ? "rerun" : "run",
      disabled: isRunning || !discoveryDone,
      reason: isRunning ? "Pipeline is running" : !discoveryDone ? "Run Discovery first" : undefined,
    },
    forum_prep: {
      action: "forum_prep",
      label: forumPrepDone ? "Re-run" : "Run",
      variant: forumPrepDone ? "rerun" : "run",
      disabled: isRunning || !enrichmentDone,
      reason: isRunning ? "Pipeline is running" : !enrichmentDone ? "Run Enrichment first" : undefined,
    },
    forum: {
      action: "forum",
      label: forumDone ? "Re-run" : "Run",
      variant: forumDone ? "rerun" : "run",
      disabled: isRunning || !forumPrepDone,
      reason: isRunning ? "Pipeline is running" : !forumPrepDone ? "Run Forum Prep first" : undefined,
    },
    expert_council: {
      action: "score",
      label: allDone ? "Re-run" : "Run",
      variant: allDone ? "rerun" : "run",
      disabled: isRunning || !forumDone,
      reason: isRunning ? "Pipeline is running" : !forumDone ? "Run Forum first" : undefined,
    },
  }
}

function stagesCompletedByStatus(status: string): Set<PipelineStage> {
  const map: Record<string, PipelineStage[]> = {
    review_parties: ["discovery"],
    enrichment: ["discovery"],
    review_enrichment: ["discovery", "enrichment"],
    weight: ["discovery", "enrichment"],
    forum_prep: ["discovery", "enrichment"],
    review_forum_prep: ["discovery", "enrichment", "forum_prep"],
    forum: ["discovery", "enrichment", "forum_prep"],
    review_forum: ["discovery", "enrichment", "forum_prep", "forum"],
    expert_council: ["discovery", "enrichment", "forum_prep", "forum"],
    complete: ["discovery", "enrichment", "forum_prep", "forum", "expert_council"],
  }
  return new Set(map[status] ?? [])
}

function stageRunningByStatus(status: string): PipelineStage | null {
  const map: Record<string, PipelineStage> = {
    discovery: "discovery",
    enrichment: "enrichment",
    weight: "forum_prep",
    forum_prep: "forum_prep",
    forum: "forum",
    expert_council: "expert_council",
  }
  return map[status] ?? null
}

function StageCard({ label, state, action, onAction }: {
  label: string
  state: "pending" | "running" | "done"
  action: StageAction
  onAction: (a: PipelineAction) => void | Promise<void>
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-background p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium">{label}</span>
          <span className={cn("text-[10px] font-medium uppercase tracking-wide", state === "done" ? "text-emerald-500" : state === "running" ? "text-primary" : "text-muted-foreground")}>
            {state === "done" ? "Done" : state === "running" ? "Running" : "Pending"}
          </span>
        </div>
        <Button
          size="sm"
          variant={action.variant === "rerun" ? "outline" : "default"}
          className="h-6 px-2 text-[11px]"
          disabled={action.disabled}
          title={action.reason}
          onClick={() => onAction(action.action)}
        >
          {action.variant === "rerun" ? <RotateCcw className="mr-1 size-3" /> : <Play className="mr-1 size-3" />}
          {action.label}
        </Button>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={cn(
          "h-full rounded-full transition-all",
          state === "done" ? "bg-emerald-500" : state === "running" ? "animate-pulse bg-primary" : "",
        )} style={{ width: state === "pending" ? "0%" : "100%" }} />
      </div>
    </div>
  )
}

function FeedRow({ item }: { item: PipelineFeedItem }) {
  const meta = (() => {
    switch (item.type) {
      case "think": return { icon: <Sparkles size={14} />, title: item.label, detail: item.detail }
      case "progress": return { icon: <Clock3 size={14} />, title: item.msg || item.stage, detail: undefined }
      case "forum_turn": return { icon: <MessagesSquare size={14} />, title: "Forum turn", detail: stringifyTurn(item.turn) }
      case "clue_discovered": return { icon: <Lightbulb size={14} />, title: item.title, detail: `${item.source} · relevance ${Math.round(item.relevance)}` }
      case "stage_complete": return { icon: <CircleDot size={14} />, title: `Stage complete · ${item.stage}`, detail: undefined }
      case "error": return { icon: <TriangleAlert size={14} />, title: "Error", detail: item.message }
      case "weight_result": return { icon: <Search size={14} />, title: "Forum prep results", detail: item.parties.map(p => `${p.name} ${p.weight}`).join(" · ") }
      case "expert_assessment": return { icon: <Sparkles size={14} />, title: item.expert, detail: `${item.domain} · ${item.summary}` }
      case "verdict_content": return { icon: <AlertCircle size={14} />, title: "Verdict", detail: item.headline }
    }
  })()
  return <div className="flex gap-3 rounded-lg border border-border/60 bg-card px-3 py-2 text-sm"><div className="mt-0.5 text-muted-foreground">{meta.icon}</div><div className="min-w-0 flex-1"><div className="font-medium">{meta.title}</div>{meta.detail && <div className="truncate text-xs text-muted-foreground">{meta.detail}</div>}</div></div>
}

function stringifyTurn(turn: Record<string, unknown>) {
  return String(turn.statement ?? turn.content ?? turn.position ?? "Forum update")
}


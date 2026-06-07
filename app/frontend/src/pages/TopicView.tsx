import { useEffect, useState, useCallback } from "react"
import { Navigate, useParams, useSearchParams } from "react-router-dom"
import { api, type Topic } from "@/api/client"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { PipelineActivityFeed } from "@/components/Pipeline/PipelineActivityFeed"
import { OperationModal } from "@/components/Pipeline/OperationModal"
import { PartiesPanel } from "@/components/Topic/PartiesPanel"
import { CluesPanel } from "@/components/Topic/CluesPanel"
import { ForumTab } from "@/components/Topic/ForumTab"
import { VerdictPanel } from "@/components/Expert/VerdictPanel"
import { SteeringPanel } from "@/components/Topic/SteeringPanel"


const TAB_SLUGS = ["overview", "parties", "evidence", "forum", "verdict"] as const

type TabSlug = typeof TAB_SLUGS[number]

const tabFromSlug = (slug?: string | null): TabSlug => TAB_SLUGS.includes(slug as TabSlug) ? slug as TabSlug : "overview"

export function TopicView() {
  const { id } = useParams()
  const [params, setParams] = useSearchParams()
  const activeTab = tabFromSlug(params.get("tab"))
  const [topic, setTopic] = useState<Topic | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [states, setStates] = useState<any[]>([])
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null)

  const loadStates = useCallback((topicId: string) => {
    api.states.list(topicId).then(setStates).catch(() => {})
  }, [])

  useEffect(() => {
    if (!id) return
    setError(null)
    api.topics.get(id).then(setTopic).catch((e) => setError(e instanceof Error ? e.message : String(e)))
    loadStates(id)
  }, [id, loadStates])



  const refreshTopic = () => {
    if (!id) return
    api.topics.get(id).then(setTopic).catch(() => {})
    loadStates(id)
  }

  async function handlePipelineAction(action: string) {
    if (!id) return
    const statusMap: Record<string, string> = {
      discover: "discovery", enrich: "enrichment", forum_prep: "forum_prep",
      forum: "forum", score: "expert_council", analyze: "forum_prep", reanalyze: "forum_prep",
    }
    // All stages use PipelineActivityFeed for SSE — no popup modal needed
    try {
      const apiCall: Record<string, () => Promise<unknown>> = {
        discover: () => api.pipeline.discover(id),
        enrich: () => api.pipeline.enrich(id),
        forum_prep: () => api.pipeline.forumPrep(id),
        forum: () => api.pipeline.forum(id),
        score: () => api.pipeline.score(id),
        analyze: () => api.pipeline.analyze(id),
        reanalyze: () => api.pipeline.reanalyze(id),
      }
      await apiCall[action]?.()
      setTopic(current => current ? { ...current, status: statusMap[action] ?? current.status } : current)
    } catch {
      refreshTopic()
    }
  }

  if (error) return <div className="p-6 text-sm text-destructive">{error}</div>
  if (!id) return <Navigate to="/" replace />
  if (!topic) return <div className="p-6 text-sm text-muted-foreground">Loading topic…</div>

  const viewingVersion = selectedVersion ?? topic.current_version
  const isCurrentVersion = viewingVersion === topic.current_version
  const selectedState = states.find((s: any) => s.version === viewingVersion)

  // For historical complete versions, show all stages as complete.
  // For in-progress versions that aren't the current pipeline, derive status from fork_stage.
  // For the current version, use the live topic status.
  const effectiveStatus = isCurrentVersion
    ? topic.status
    : selectedState?.version_status === "complete"
      ? "complete"
      : topic.status

  const completedStages: string[] = selectedState?.completed_stages ?? []
  const pipelineFeed = <PipelineActivityFeed topicId={id} status={effectiveStatus} completedStages={completedStages} active={topic.status !== "draft"} onAction={handlePipelineAction} onStageComplete={refreshTopic} />
  const content = {
    overview: <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border/70 bg-card/80 px-4 py-2.5 text-sm">
        <span className="text-muted-foreground">Status</span>
        <Badge variant="secondary" className="capitalize">{topic.status.replace(/_/g, " ")}</Badge>
        <span className="text-border">|</span>
        <span className="text-muted-foreground">Version</span>
        {states.length > 1 ? (
          <Select value={String(selectedVersion ?? topic.current_version)} onValueChange={(v) => setSelectedVersion(parseInt(v))}>
            <SelectTrigger className="h-7 w-auto min-w-[80px] gap-1 border-none bg-transparent px-1 text-sm font-medium">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {states.map((s) => (
                <SelectItem key={s.version} value={String(s.version)}>
                  v{s.version}{s.version_status === "in_progress" ? " (running)" : ""} — {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="font-medium">v{topic.current_version}</span>
        )}
        <span className="text-border">|</span>
        <span className="truncate font-mono text-xs text-muted-foreground">{topic.id}</span>
      </div>
      {pipelineFeed}
      <SteeringPanel topicId={id} />
    </div>,
    parties: <PartiesPanel topicId={id} status={topic.status} version={viewingVersion} />,
    evidence: <CluesPanel topicId={id} version={viewingVersion} isCurrentVersion={isCurrentVersion} />,
    forum: <ForumTab topicId={id} version={viewingVersion} />,
    verdict: <VerdictPanel topicId={id} version={viewingVersion} />,
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">{topic.title}</h1>
            <Badge variant="secondary" className="capitalize">{topic.status.replace(/_/g, " ")}</Badge>
            {(topic.settings as Record<string, unknown>)?.is_demo === true && (
              <Badge variant="outline" className="border-blue-500/40 text-blue-400">Demo</Badge>
            )}
          </div>
          <p className="max-w-3xl text-sm text-muted-foreground">{topic.description || "No description yet."}</p>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={(value) => setParams(value === "overview" ? {} : { tab: value })}>
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="parties">Parties</TabsTrigger>
          <TabsTrigger value="evidence">Evidence</TabsTrigger>
          <TabsTrigger value="forum">Forum</TabsTrigger>
          <TabsTrigger value="verdict">Verdict</TabsTrigger>
        </TabsList>
        {TAB_SLUGS.map(slug => <TabsContent key={slug} value={slug} className="mt-4">{content[slug]}</TabsContent>)}
      </Tabs>

      <OperationModal onComplete={refreshTopic} />
    </div>
  )
}





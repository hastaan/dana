import { useEffect, useMemo, useState } from "react"
import { api } from "@/api/client"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

interface ScenarioAssessment {
  scenario_id: string
  assessment: string
  historic_analogues: string[]
  weak_points_identified: string[]
  probability_contribution: number
}

interface ExpertDeliberation {
  expert_id: string
  expert_name: string
  domain: string
  scenario_assessments: ScenarioAssessment[]
  weight_challenges: { party_id: string; dimension: string; original_score: number; suggested_score: number; reasoning: string }[]
  cross_deliberation_response?: string
}

interface ExpertCouncil {
  version: number
  deliberations: ExpertDeliberation[]
}

const DOMAIN_STYLES: Record<string, string> = {
  geopolitics: "bg-blue-500/10 text-blue-300 border-blue-500/20",
  history: "bg-amber-500/10 text-amber-300 border-amber-500/20",
  psychology: "bg-violet-500/10 text-violet-300 border-violet-500/20",
  economics: "bg-emerald-500/10 text-emerald-300 border-emerald-500/20",
  military: "bg-rose-500/10 text-rose-300 border-rose-500/20",
  sociology: "bg-pink-500/10 text-pink-300 border-pink-500/20",
  legal: "bg-slate-500/10 text-slate-300 border-slate-500/20",
  media: "bg-cyan-500/10 text-cyan-300 border-cyan-500/20",
}

export function ExpertCouncilPanel({ topicId, version }: { topicId: string; version?: number }) {
  const [council, setCouncil] = useState<ExpertCouncil | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeExpertId, setActiveExpertId] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    const fetcher = version ? api.expertCouncil.getVersion(topicId, version) : api.expertCouncil.get(topicId)
    fetcher.then((data) => {
      setCouncil(data)
      setActiveExpertId(data?.deliberations?.[0]?.expert_id ?? null)
    }).catch(() => setCouncil(null)).finally(() => setLoading(false))
  }, [topicId, version])

  const aggregated = useMemo(() => {
    const scenarioTotals = new Map<string, { total: number; count: number }>()
    for (const deliberation of council?.deliberations ?? []) {
      for (const assessment of deliberation.scenario_assessments) {
        const entry = scenarioTotals.get(assessment.scenario_id) ?? { total: 0, count: 0 }
        entry.total += assessment.probability_contribution
        entry.count += 1
        scenarioTotals.set(assessment.scenario_id, entry)
      }
    }
    return [...scenarioTotals.entries()]
      .map(([scenario_id, entry]) => ({ scenario_id, probability: entry.total / entry.count }))
      .sort((a, b) => b.probability - a.probability)
  }, [council])

  if (loading) return <div className="py-12 text-center text-sm text-muted-foreground">Loading scenario scoring…</div>
  if (!council || !council.deliberations.length) return <EmptyState />

  const activeExpert = council.deliberations.find((expert) => expert.expert_id === activeExpertId) ?? council.deliberations[0]

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">Scenario scoring</p>
          <h2 className="text-xl font-semibold">Per-expert assessments</h2>
          <CardDescription>Switch between expert deliberations to compare scenario views.</CardDescription>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {council.deliberations.map((expert) => (
          <button key={expert.expert_id} onClick={() => setActiveExpertId(expert.expert_id)} className={`rounded-full border px-3 py-1.5 text-sm transition ${activeExpert.expert_id === expert.expert_id ? "border-primary bg-primary/15 text-primary" : "border-border bg-card text-muted-foreground hover:text-foreground"}`}>
            <span className={`mr-2 rounded-full border px-2 py-0.5 text-xs ${DOMAIN_STYLES[expert.domain] ?? "border-border bg-muted text-muted-foreground"}`}>{expert.domain}</span>
            {expert.expert_name}
          </button>
        ))}
      </div>

      <Card className="gap-0">
        <CardHeader className="border-b border-border/60">
          <CardTitle className="text-sm uppercase tracking-[0.2em] text-muted-foreground">Aggregated scenario probabilities</CardTitle>
          <CardDescription>Average probability contribution across all experts.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 pt-4">
          {aggregated.map((row) => (
            <div key={row.scenario_id} className="grid gap-2 md:grid-cols-[10rem_1fr_auto] md:items-center">
              <div className="truncate text-sm font-medium text-foreground">{row.scenario_id}</div>
              <div className="h-2 rounded-full bg-muted"><div className="h-2 rounded-full bg-blue-500" style={{ width: `${Math.round(row.probability * 100)}%` }} /></div>
              <div className="text-sm tabular-nums text-muted-foreground">{Math.round(row.probability * 100)}%</div>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="space-y-3">
        {activeExpert.scenario_assessments.map((assessment) => (
          <Card key={assessment.scenario_id} className="gap-0">
            <CardHeader className="border-b border-border/60">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-base">{assessment.scenario_id}</CardTitle>
                  <CardDescription>{activeExpert.expert_name} · {activeExpert.domain}</CardDescription>
                </div>
                <Badge variant="outline">{Math.round(assessment.probability_contribution * 100)}%</Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4 pt-4">
              <p className="text-sm leading-6 text-foreground/90">{assessment.assessment}</p>
              {assessment.historic_analogues.length > 0 && <TagList title="Historic analogues" values={assessment.historic_analogues} />}
              {assessment.weak_points_identified.length > 0 && <TagList title="Weak points" values={assessment.weak_points_identified} tone="rose" />}
            </CardContent>
          </Card>
        ))}

        {activeExpert.weight_challenges.length > 0 && (
          <Card className="gap-0 border-amber-500/20 bg-amber-500/5">
            <CardHeader className="border-b border-amber-500/20">
              <CardTitle className="text-sm uppercase tracking-[0.2em] text-amber-200">Weight challenges</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 pt-4 text-sm text-amber-50">
              {activeExpert.weight_challenges.map((challenge) => <div key={`${challenge.party_id}-${challenge.dimension}`}>{challenge.party_id} / {challenge.dimension}: {challenge.original_score} → {challenge.suggested_score} — {challenge.reasoning}</div>)}
            </CardContent>
          </Card>
        )}

        {activeExpert.cross_deliberation_response && (
          <Card className="gap-0">
            <CardHeader className="border-b border-border/60">
              <CardTitle className="text-sm uppercase tracking-[0.2em] text-muted-foreground">Cross-deliberation response</CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              <p className="whitespace-pre-line text-sm leading-6 text-foreground/90">{activeExpert.cross_deliberation_response}</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}

function TagList({ title, values, tone = "blue" }: { title: string; values: string[]; tone?: "blue" | "rose" }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs uppercase tracking-[0.2em] text-muted-foreground">{title}</h3>
      <div className="flex flex-wrap gap-2">
        {values.map((value) => <Badge key={value} variant="secondary" className={tone === "rose" ? "bg-rose-500/10 text-rose-300" : "bg-blue-500/10 text-blue-300"}>{value}</Badge>)}
      </div>
    </section>
  )
}

function EmptyState() {
  return <Card><CardContent className="flex min-h-64 flex-col items-center justify-center py-12 text-center"><div className="text-lg font-semibold">No scoring data available yet.</div><p className="mt-2 max-w-md text-sm text-muted-foreground">Scenario probabilities and the final verdict will appear here once analysis completes.</p></CardContent></Card>
}

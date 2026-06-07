import { Badge } from "@/components/ui/badge"

const STATUS_META: Record<string, { label: string; className: string }> = {
  draft: { label: "Draft", className: "bg-muted text-muted-foreground border-border" },
  discovery: { label: "Discovery", className: "bg-sky-500/15 text-sky-700 border-sky-500/20" },
  review_parties: { label: "Review Parties", className: "bg-amber-500/15 text-amber-700 border-amber-500/20" },
  enrichment: { label: "Enrichment", className: "bg-indigo-500/15 text-indigo-700 border-indigo-500/20" },
  review_enrichment: { label: "Review Clues", className: "bg-amber-500/15 text-amber-700 border-amber-500/20" },
  weight: { label: "Forum Prep", className: "bg-cyan-500/15 text-cyan-700 border-cyan-500/20" },
  forum_prep: { label: "Forum Prep", className: "bg-cyan-500/15 text-cyan-700 border-cyan-500/20" },
  review_forum_prep: { label: "Review Personas", className: "bg-amber-500/15 text-amber-700 border-amber-500/20" },
  forum: { label: "Forum", className: "bg-violet-500/15 text-violet-700 border-violet-500/20" },
  review_forum: { label: "Review Forum", className: "bg-amber-500/15 text-amber-700 border-amber-500/20" },
  expert_council: { label: "Scenario Scoring", className: "bg-yellow-500/15 text-yellow-700 border-yellow-500/20" },
  complete: { label: "Complete", className: "bg-emerald-500/15 text-emerald-700 border-emerald-500/20" },
  stale: { label: "Stale", className: "bg-red-500/15 text-red-700 border-red-500/20" },
}

export function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { label: status.replaceAll("_", " "), className: "bg-muted text-muted-foreground border-border" }
  return <Badge variant="outline" className={meta.className}>{meta.label}</Badge>
}

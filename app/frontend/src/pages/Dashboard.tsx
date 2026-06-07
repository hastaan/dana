import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Loader2, Plus } from "lucide-react"
import { useTopicsStore } from "../stores/topicsStore"
import { TopicCard } from "../components/Dashboard/TopicCard"
import { NewTopicDialog } from "../components/Dashboard/NewTopicDialog"
import { Button } from "@/components/ui/button"

export function Dashboard() {
  const navigate = useNavigate()
  const { topics, loading, error, fetch, create, delete: deleteTopic } = useTopicsStore()
  const [showDialog, setShowDialog] = useState(false)
  useEffect(() => { void fetch() }, [fetch])

  return (
    <main className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Manage your geopolitical analyses.</p>
        </div>
        <Button onClick={() => setShowDialog(true)}><Plus className="mr-2 h-4 w-4" /> New Analysis</Button>
      </div>

      {loading && <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading topics…</div>}
      {error && <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

      {!loading && topics.length === 0 ? (
        <div className="flex min-h-[40vh] flex-col items-center justify-center rounded-2xl border border-dashed p-10 text-center">
          <h2 className="text-lg font-semibold">No analyses yet</h2>
          <p className="mt-2 text-sm text-muted-foreground">Create your first analysis to begin tracking parties, clues, and outcomes.</p>
          <Button className="mt-6" onClick={() => setShowDialog(true)}>Create your first analysis</Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {topics.map(topic => <TopicCard key={topic.id} topic={topic} onDelete={deleteTopic} onOpen={() => navigate(`/topic/${topic.id}`)} />)}
        </div>
      )}

      <NewTopicDialog open={showDialog} onOpenChange={setShowDialog} onCreate={async (title, description) => { const topic = await create(title, description); navigate(`/topic/${topic.id}`) }} />
    </main>
  )
}

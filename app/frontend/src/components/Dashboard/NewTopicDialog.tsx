import { useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

export function NewTopicDialog({ open, onOpenChange, onCreate }: { open: boolean; onOpenChange: (open: boolean) => void; onCreate: (title: string, description: string) => Promise<unknown> }) {
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return setError("Title is required")
    setLoading(true)
    setError("")
    try { await onCreate(title.trim(), description.trim()); onOpenChange(false) } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setLoading(false) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Analysis</DialogTitle>
          <DialogDescription>Create a new topic to start an analysis.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Title</label>
            <input className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={title} onChange={e => setTitle(e.target.value)} placeholder="Required" autoFocus />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Description</label>
            <textarea className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={description} onChange={e => setDescription(e.target.value)} placeholder="Optional context" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={loading}>{loading ? "Creating…" : "Create Analysis"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

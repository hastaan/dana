import { useState, useEffect } from "react"

interface DeltaSummary {
  new_clues: string[]
  updated_clues: string[]
  affected_parties: string[]
  key_change: string
}

interface KnowledgeState {
  version: number
  label: string
  created_at: string
  clue_snapshot: { count: number }
  delta_summary: DeltaSummary | null
}

interface Props {
  topicId: string
  status: string
  onUpdate: () => void
}

export function StalenessBanner({ topicId, status, onUpdate }: Props) {
  const [states, setStates] = useState<KnowledgeState[]>([])
  const [showDiff, setShowDiff] = useState(false)
  const [currentClueCount, setCurrentClueCount] = useState(0)

  useEffect(() => {
    if (status !== "stale") return
    fetch(`/api/topics/${topicId}/states`)
      .then(r => r.json())
      .then(setStates)
      .catch(() => {})
    fetch(`/api/topics/${topicId}/clues`)
      .then(r => r.json())
      .then((clues: unknown[]) => setCurrentClueCount(clues.length))
      .catch(() => {})
  }, [topicId, status])

  if (status !== "stale") return null

  const latest = states[states.length - 1]
  const prevCount = latest?.clue_snapshot.count ?? 0
  const newCount = currentClueCount - prevCount
  const latestDate = latest ? new Date(latest.created_at).toLocaleDateString() : ""

  return (
    <>
      <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 flex items-center justify-between gap-4">
        <div className="text-sm text-amber-800">
          <span className="font-medium">
            {newCount > 0 ? `${newCount} new clue(s)` : "Clues updated"}
          </span>
          {" "}since last analysis
          {latest && <span className="text-amber-600"> (v{latest.version}, {latestDate})</span>}
          {latest?.delta_summary?.key_change && (
            <span className="text-amber-600"> · {latest.delta_summary.key_change}</span>
          )}
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            className="text-xs px-3 py-1 border border-amber-300 text-amber-700 rounded hover:bg-amber-100"
            onClick={() => setShowDiff(true)}
          >
            View Changes
          </button>
          <button
            className="text-xs px-3 py-1 bg-amber-600 text-white rounded hover:bg-amber-700"
            onClick={onUpdate}
          >
            Update
          </button>
        </div>
      </div>

      {showDiff && latest && (
        <DiffModal state={latest} topicId={topicId} onClose={() => setShowDiff(false)} />
      )}
    </>
  )
}

function DiffModal({ state, topicId, onClose }: { state: KnowledgeState; topicId: string; onClose: () => void }) {
  const [clues, setClues] = useState<any[]>([])

  useEffect(() => {
    fetch(`/api/topics/${topicId}/clues`).then(r => r.json()).then(setClues)
  }, [topicId])

  const prevVersions = (state.clue_snapshot as any).ids_and_versions ?? {}

  const newClues = clues.filter(c => !(c.id in prevVersions))
  const updatedClues = clues.filter(c => c.id in prevVersions && c.current > prevVersions[c.id])

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-2xl max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold">Changes since v{state.version}</h2>
          <button className="text-gray-400 hover:text-gray-600" onClick={onClose}>✕</button>
        </div>

        {newClues.length > 0 && (
          <div className="mb-4">
            <h3 className="text-sm font-medium text-green-700 mb-2">New clues ({newClues.length})</h3>
            <div className="space-y-2">
              {newClues.map(c => {
                const cur = c.versions.find((v: any) => v.v === c.current)
                return (
                  <div key={c.id} className="text-xs border border-green-100 bg-green-50 rounded p-2">
                    <div className="font-medium text-gray-800">{cur?.title}</div>
                    <div className="text-gray-500 mt-0.5">{cur?.bias_corrected_summary}</div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {updatedClues.length > 0 && (
          <div>
            <h3 className="text-sm font-medium text-orange-700 mb-2">Updated clues ({updatedClues.length})</h3>
            <div className="space-y-2">
              {updatedClues.map(c => {
                const cur = c.versions.find((v: any) => v.v === c.current)
                return (
                  <div key={c.id} className="text-xs border border-orange-100 bg-orange-50 rounded p-2">
                    <div className="font-medium text-gray-800">{cur?.title} <span className="text-orange-500">v{c.current}</span></div>
                    <div className="text-gray-500 mt-0.5">{cur?.bias_corrected_summary}</div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {newClues.length === 0 && updatedClues.length === 0 && (
          <p className="text-sm text-gray-400">No changes detected.</p>
        )}
      </div>
    </div>
  )
}

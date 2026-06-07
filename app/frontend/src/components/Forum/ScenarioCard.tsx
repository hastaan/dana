import { useState } from "react"
import { X } from "lucide-react"

interface Scenario {
  id: string
  title: string
  description: string
  proposed_by: string
  supported_by: string[]
  contested_by: string[]
  clues_cited: string[]
  required_conditions: string[]
  falsification_conditions: string[]
}

function ScenarioDetailPopup({ scenario, onClose, onClueClick }: { scenario: Scenario; onClose: () => void; onClueClick?: (id: string) => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative w-full max-w-lg rounded-xl border border-purple-500/20 bg-card shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold text-foreground">{scenario.title}</h3>
          <button className="text-muted-foreground hover:text-foreground p-1 rounded hover:bg-muted transition-colors" onClick={onClose}>
            <X className="size-4" />
          </button>
        </div>
        <div className="px-4 py-3 space-y-3 max-h-[60vh] overflow-y-auto">
          <div className="flex items-center gap-3 text-[11px]">
            <span className="text-muted-foreground">by {scenario.proposed_by.replace("rep-", "")}</span>
            {scenario.supported_by.length > 0 && <span className="text-emerald-400">+{scenario.supported_by.length} support</span>}
            {scenario.contested_by.length > 0 && <span className="text-red-400">{scenario.contested_by.length} contest</span>}
          </div>

          {scenario.description && <p className="text-xs text-muted-foreground leading-relaxed">{scenario.description}</p>}

          {scenario.clues_cited.length > 0 && (
            <div className="flex gap-1 flex-wrap">
              {scenario.clues_cited.map(id => (
                <button
                  key={id}
                  className="text-[10px] font-mono px-1.5 py-0.5 bg-primary/10 border border-primary/20 text-primary rounded hover:bg-primary/20 transition-colors"
                  onClick={() => onClueClick?.(id)}
                >
                  {id}
                </button>
              ))}
            </div>
          )}

          {scenario.required_conditions.length > 0 && (
            <div>
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">Required conditions</p>
              <ul className="text-xs text-muted-foreground list-disc list-inside space-y-0.5">
                {scenario.required_conditions.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </div>
          )}

          {scenario.falsification_conditions.length > 0 && (
            <div>
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">Falsification conditions</p>
              <ul className="text-xs text-muted-foreground list-disc list-inside space-y-0.5">
                {scenario.falsification_conditions.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function ScenarioCard({ scenario, onClueClick }: { scenario: Scenario; onClueClick?: (id: string) => void }) {
  const [showDetail, setShowDetail] = useState(false)

  return (
    <>
      <button
        className="w-full text-left border border-purple-500/20 bg-purple-500/5 rounded-lg px-3 py-2 hover:bg-purple-500/10 transition-colors"
        onClick={() => setShowDetail(true)}
      >
        <h4 className="text-xs font-semibold text-foreground truncate">{scenario.title}</h4>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[10px] text-muted-foreground truncate">by {scenario.proposed_by.replace("rep-", "")}</span>
          {scenario.supported_by.length > 0 && <span className="text-[10px] text-emerald-400">+{scenario.supported_by.length}</span>}
          {scenario.contested_by.length > 0 && <span className="text-[10px] text-red-400">-{scenario.contested_by.length}</span>}
        </div>
      </button>
      {showDetail && <ScenarioDetailPopup scenario={scenario} onClose={() => setShowDetail(false)} onClueClick={onClueClick} />}
    </>
  )
}

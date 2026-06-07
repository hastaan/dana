import { useState, useEffect, useRef } from "react"
import { useSSE } from "../../hooks/useSSE"
import { TurnBubble } from "./TurnBubble"
import { ScenarioCard } from "./ScenarioCard"
import { ClueDetailSidebar } from "./ClueDetailSidebar"

interface Turn {
  id: string
  representative_id: string
  party_name: string
  persona_title?: string
  party_color?: string
  statement: string
  position?: string
  evidence?: { claim: string; clue_id: string; interpretation: string }[]
  challenges?: { target_party: string; challenge: string; clue_id?: string }[]
  concessions?: string[]
  scenario_endorsement?: string
  moderator_directive?: string
  moderator_reason?: string
  clues_cited: string[]
  timestamp: string
  round: number
  type: string
  word_count: number
  prior_position_summary?: string
  position_delta?: string
}

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

interface ForumSession {
  session_id: string
  type: "full" | "delta"
  status: "running" | "complete" | "error"
  rounds: { round: number; type: string; turns: Turn[] }[]
  scenarios: Scenario[]
}

function ModeratorNote({ directive }: { directive: string }) {
  return (
    <div className="flex items-start gap-2.5 pl-1">
      <div className="w-5 h-5 rounded-full shrink-0 flex items-center justify-center bg-amber-500/20 text-amber-400 text-[9px] font-bold mt-0.5">
        M
      </div>
      <div className="flex-1 min-w-0">
        <span className="text-[10px] font-semibold text-amber-400 uppercase tracking-wide">Moderator</span>
        <p className="text-xs text-amber-200/80 italic leading-relaxed">{directive}</p>
      </div>
    </div>
  )
}

export function ConversationView({ topicId, sessionId, isLive }: { topicId: string; sessionId: string; isLive?: boolean }) {
  const [session, setSession] = useState<ForumSession | null>(null)
  const [liveTurns, setLiveTurns] = useState<Turn[]>([])
  const [scrubPos, setScrubPos] = useState<number>(100)
  const [selectedClue, setSelectedClue] = useState<string | null>(null)
  const [filterRep, setFilterRep] = useState("")
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch(`/api/topics/${topicId}/forum/${sessionId}`)
      .then(r => r.json())
      .then(setSession)
      .catch(() => {})
  }, [topicId, sessionId])

  useSSE(isLive ? topicId : null, (event) => {
    if (event.type === "forum_turn") {
      setLiveTurns(prev => {
        const turn = event.turn as unknown as Turn
        if (prev.some(t => t.id === turn.id)) return prev
        return [...prev, turn]
      })
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 100)
    }
  })

  const allTurns: Turn[] = [
    ...(session?.rounds.flatMap(r => r.turns) ?? []),
    ...liveTurns.filter(lt => !session?.rounds.some(r => r.turns.some(t => t.id === lt.id))),
  ]

  const isComplete = session?.status === "complete"
  const displayedTurns = isComplete
    ? allTurns.slice(0, Math.ceil(allTurns.length * scrubPos / 100))
    : allTurns

  const filteredTurns = filterRep
    ? displayedTurns.filter(t => t.representative_id === filterRep)
    : displayedTurns

  const allReps = [...new Set(allTurns.map(t => t.representative_id))]
  const scenarios = session?.scenarios ?? []

  return (
    <div className="flex flex-col h-full relative">
      {/* Filter bar */}
      <div className="flex items-center gap-3 pb-3 border-b border-border">
        <select
          className="text-xs border border-border rounded-md px-2 py-1.5 bg-muted text-foreground"
          value={filterRep}
          onChange={e => setFilterRep(e.target.value)}
        >
          <option value="">All representatives</option>
          {allReps.map(r => <option key={r} value={r}>{r.replace("rep-", "").replace(/_/g, " ")}</option>)}
        </select>
        <span className="text-xs text-muted-foreground tabular-nums">{filteredTurns.length} turns</span>
        {session?.type === "delta" && (
          <span className="text-[10px] bg-orange-500/10 text-orange-400 px-2 py-0.5 rounded-full border border-orange-500/20">Delta session</span>
        )}
      </div>

      {/* Conversation thread — continuous, no round dividers */}
      <div className="flex-1 overflow-y-auto space-y-3 py-4">
        {filteredTurns.map(turn => (
          <div key={turn.id} className="space-y-1.5">
            {turn.moderator_directive && (
              <ModeratorNote directive={turn.moderator_directive} />
            )}
            <TurnBubble
              turn={turn}
              topicId={topicId}
              isDelta={session?.type === "delta"}
              onClueClick={setSelectedClue}
            />
          </div>
        ))}

        {/* Scenarios section */}
        {scenarios.length > 0 && scrubPos >= 100 && (
          <div>
            <div className="flex items-center gap-3 mb-3">
              <div className="flex-1 border-t border-purple-500/30" />
              <span className="text-[10px] text-purple-400 font-medium uppercase tracking-wide">Scenarios ({scenarios.length})</span>
              <div className="flex-1 border-t border-purple-500/30" />
            </div>
            <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
              {scenarios.map(s => (
                <ScenarioCard key={s.id} scenario={s} onClueClick={setSelectedClue} />
              ))}
            </div>
          </div>
        )}

        {isLive && liveTurns.length === 0 && !session && (
          <div className="text-center text-muted-foreground text-sm py-12">Waiting for forum to begin...</div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Replay scrub bar */}
      {isComplete && allTurns.length > 0 && (
        <div className="border-t border-border pt-3 flex items-center gap-3">
          <span className="text-[10px] text-muted-foreground shrink-0 uppercase tracking-wide">Replay</span>
          <input
            type="range"
            min={0}
            max={100}
            value={scrubPos}
            onChange={e => setScrubPos(Number(e.target.value))}
            className="flex-1 accent-primary"
          />
          <span className="text-xs text-muted-foreground tabular-nums shrink-0">
            {Math.ceil(allTurns.length * scrubPos / 100)}/{allTurns.length}
          </span>
        </div>
      )}

      {selectedClue && (
        <ClueDetailSidebar
          topicId={topicId}
          clueId={selectedClue}
          onClose={() => setSelectedClue(null)}
        />
      )}
    </div>
  )
}

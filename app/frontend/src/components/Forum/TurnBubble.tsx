import { useState, useMemo } from "react"
import { partyColor, partyColorAlpha } from "../../utils/partyColor"

function parseStructuredFromStatement(turn: Turn): Turn {
  const hasStructured = turn.position || (turn.evidence && turn.evidence.length > 0)
  if (hasStructured) return turn

  const raw = turn.statement
  if (!raw || typeof raw !== "string") return turn
  if (!raw.includes('"position"') && !raw.includes('"evidence"')) return turn

  const cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "")
  let position: string | undefined
  let evidence: EvidenceItem[] | undefined
  let challenges: ChallengeItem[] | undefined
  let concessions: string[] | undefined
  let scenario_endorsement: string | undefined
  let statement = ""

  try {
    const jsonMatch = cleaned.match(/\{[\s\S]+\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      position = parsed.position
      evidence = parsed.evidence
      challenges = parsed.challenges
      concessions = parsed.concessions
      scenario_endorsement = parsed.scenario_endorsement
      statement = parsed.statement || ""
    }
  } catch {
    try {
      const posMatch = cleaned.match(/"position"\s*:\s*"((?:[^"\\]|\\.)*)"/s)
      if (posMatch) position = posMatch[1].replace(/\\"/g, '"').replace(/\\n/g, "\n")

      const evMatch = cleaned.match(/"evidence"\s*:\s*(\[[\s\S]*?\])\s*(?:,\s*"challenges)/s)
      if (evMatch) try { evidence = JSON.parse(evMatch[1]) } catch { evidence = undefined }

      const chMatch = cleaned.match(/"challenges"\s*:\s*(\[[\s\S]*?\])\s*(?:,\s*"concessions)/s)
      if (chMatch) try { challenges = JSON.parse(chMatch[1]) } catch { challenges = undefined }

      const coMatch = cleaned.match(/"concessions"\s*:\s*(\[[\s\S]*?\])\s*(?:,\s*"(?:statement|scenario))/s)
      if (coMatch) try { concessions = JSON.parse(coMatch[1]) } catch { concessions = undefined }

      const seMatch = cleaned.match(/"scenario_endorsement"\s*:\s*"((?:[^"\\]|\\.)*)"/s)
      if (seMatch) scenario_endorsement = seMatch[1].replace(/\\"/g, '"')

      const stmtMatch = cleaned.match(/"statement"\s*:\s*"((?:[^"\\]|\\.)*)/)
      if (stmtMatch) statement = stmtMatch[1].replace(/\\"/g, '"').replace(/\\n/g, "\n")
    } catch { return turn }
  }

  if (!position && !evidence?.length) return turn

  return { ...turn, position, evidence, challenges, concessions, scenario_endorsement, statement: statement || turn.statement }
}

interface EvidenceItem { claim: string; clue_id: string; interpretation: string }
interface ChallengeItem { target_party: string; challenge: string; clue_id?: string }

interface Turn {
  id: string
  representative_id: string
  party_name: string
  persona_title?: string
  party_color?: string
  statement: string
  position?: string
  evidence?: EvidenceItem[]
  challenges?: ChallengeItem[]
  concessions?: string[]
  scenario_endorsement?: string
  clues_cited: string[]
  timestamp: string
  round: number
  type: string
  word_count: number
  prior_position_summary?: string
  position_delta?: string
}

interface Props {
  turn: Turn
  topicId: string
  isDelta?: boolean
  onClueClick?: (clueId: string) => void
}

function ClueChip({ clueId, onClick }: { clueId: string; onClick?: (id: string) => void }) {
  return (
    <button
      className="inline-flex items-center px-1.5 py-0.5 text-[10px] bg-primary/10 text-primary rounded font-mono border border-primary/20 hover:bg-primary/20 transition-colors"
      onClick={() => onClick?.(clueId.split("@")[0])}
    >
      {clueId.replace(/^clue-0*/, "")}
    </button>
  )
}

function InlineStatement({ text, onClueClick }: { text: string; onClueClick?: (id: string) => void }) {
  const parts = text.split(/(\[clue-\d+(?:@v\d+)?\])/g)
  return (
    <span>
      {parts.map((part, i) => {
        const match = part.match(/^\[(\w+-\d+(?:@v\d+)?)\]$/)
        if (match) return <ClueChip key={i} clueId={match[1]} onClick={onClueClick} />
        return <span key={i}>{part}</span>
      })}
    </span>
  )
}

function StructuredView({ turn, onClueClick }: { turn: Turn; onClueClick?: (id: string) => void }) {
  const color = turn.party_color ?? partyColor(turn.party_name)

  return (
    <div className="space-y-3">
      {turn.position && (
        <div className="text-sm text-foreground leading-relaxed font-medium" style={{ borderLeftColor: color, borderLeftWidth: 3, paddingLeft: 12 }}>
          <InlineStatement text={turn.position} onClueClick={onClueClick} />
        </div>
      )}

      {turn.evidence && turn.evidence.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Evidence</p>
          {turn.evidence.map((e, i) => (
            <div key={i} className="flex gap-2 items-start bg-muted/50 rounded px-3 py-2">
              <div className="flex-1 min-w-0">
                <p className="text-xs text-foreground">{e.claim}</p>
                {e.interpretation && <p className="text-xs text-muted-foreground mt-0.5 italic">{e.interpretation}</p>}
              </div>
              {e.clue_id && <ClueChip clueId={e.clue_id} onClick={onClueClick} />}
            </div>
          ))}
        </div>
      )}

      {turn.challenges && turn.challenges.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold text-destructive uppercase tracking-wide">Challenges</p>
          {turn.challenges.map((c, i) => (
            <div key={i} className="flex gap-2 items-start bg-destructive/5 rounded px-3 py-2">
              <div className="flex-1 min-w-0">
                <p className="text-xs text-foreground">
                  <span className="font-medium text-destructive">vs {c.target_party}:</span> {c.challenge}
                </p>
              </div>
              {c.clue_id && <ClueChip clueId={c.clue_id} onClick={onClueClick} />}
            </div>
          ))}
        </div>
      )}

      {turn.concessions && turn.concessions.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] font-semibold text-yellow-500 uppercase tracking-wide">Concessions</p>
          {turn.concessions.map((c, i) => (
            <p key={i} className="text-xs text-muted-foreground italic pl-3 border-l-2 border-yellow-500/30">{c}</p>
          ))}
        </div>
      )}

      {turn.scenario_endorsement && (
        <div>
          <p className="text-[10px] font-semibold text-purple-400 uppercase tracking-wide">Scenario Endorsement</p>
          <p className="text-xs text-muted-foreground pl-3 border-l-2 border-purple-400/30 mt-1">
            <InlineStatement text={turn.scenario_endorsement} onClueClick={onClueClick} />
          </p>
        </div>
      )}
    </div>
  )
}

export function TurnBubble({ turn: rawTurn, isDelta, onClueClick }: Props) {
  const turn = useMemo(() => parseStructuredFromStatement(rawTurn), [rawTurn])
  const color = turn.party_color ?? partyColor(turn.party_name)
  const time = new Date(turn.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  const hasStructured = turn.position || (turn.evidence && turn.evidence.length > 0)
  const [showRaw, setShowRaw] = useState(false)

  return (
    <div className="flex gap-3 group">
      {/* Avatar */}
      <div className="shrink-0 pt-0.5">
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white shadow-sm"
          style={{ backgroundColor: color }}
        >
          {turn.party_name.slice(0, 1).toUpperCase()}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 space-y-1">
        {/* Header */}
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-semibold text-foreground">{turn.party_name}</span>
          {turn.persona_title && (
            <span className="text-[10px] text-muted-foreground italic hidden sm:inline truncate max-w-[180px]">{turn.persona_title}</span>
          )}
          <span className="text-[10px] text-muted-foreground/60 tabular-nums ml-auto shrink-0">
            T{turn.round} · {turn.word_count}w · {time}
          </span>
        </div>

        {/* Delta prior position */}
        {isDelta && turn.prior_position_summary && (
          <div className="text-xs text-muted-foreground/50 line-through italic border-l-2 border-border pl-2">
            {turn.prior_position_summary}
          </div>
        )}

        {/* Bubble */}
        <div
          className="rounded-lg border overflow-hidden"
          style={{
            borderColor: partyColorAlpha(turn.party_name, 0.15),
            borderLeftColor: partyColorAlpha(turn.party_name, 0.6),
            borderLeftWidth: 3,
            backgroundColor: partyColorAlpha(turn.party_name, 0.04),
          }}
        >
          <div className="px-3.5 py-3">
            {hasStructured && !showRaw ? (
              <StructuredView turn={turn} onClueClick={onClueClick} />
            ) : (
              <div className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
                <InlineStatement text={turn.statement} onClueClick={onClueClick} />
              </div>
            )}
          </div>

          {/* Footer */}
          {(turn.clues_cited.length > 0 || hasStructured) && (
            <div className="flex items-center gap-2 px-3.5 py-1.5 border-t border-border/40 bg-muted/20">
              {turn.clues_cited.length > 0 && (
                <div className="flex gap-1 flex-wrap flex-1">
                  {turn.clues_cited.slice(0, 6).map(cid => (
                    <ClueChip key={cid} clueId={cid} onClick={onClueClick} />
                  ))}
                  {turn.clues_cited.length > 6 && (
                    <span className="text-[10px] text-muted-foreground">+{turn.clues_cited.length - 6} more</span>
                  )}
                </div>
              )}
              {hasStructured && (
                <button
                  className="text-[10px] text-muted-foreground hover:text-foreground ml-auto shrink-0 transition-colors"
                  onClick={() => setShowRaw(r => !r)}
                >
                  {showRaw ? "structured" : "raw"}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

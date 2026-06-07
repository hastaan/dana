import { chatCompletionText } from "../llm/proxyClient"
import { budgetOutput } from "../llm/tokenBudget"
import { resolvePrompt } from "../llm/promptLoader"
import { runAgenticLoop } from "../llm/agenticLoop"
import { getPartyProfile } from "../tools/internal/getPartyProfile"
import { writeArtifact } from "../tools/internal/artifactStore"
import { log } from "../utils/logger"
import { dbGetScratchpad } from "../db/queries/forum"
import { dbGetClues } from "../db/queries/clues"
import type { ForumTurn, ForumScenario, ScratchpadContent } from "../db/queries/forum"

export interface RepTurnInput {
  topicId: string
  runId: string
  sessionId: string
  partyId: string
  personaTitle: string
  model: string
  turnNumber: number
  myTurnCount: number
  speakingWeight: number
  recentTurns: ForumTurn[]
  compressedHistory: string
  liveScenarios: ForumScenario[]
  topic: string
  moderatorDirective?: string
}

export interface RepTurnOutput {
  turn: ForumTurn | null   // null = passed
  passed: boolean
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

function formatScratchpad(content: ScratchpadContent): string {
  const clueLines = content.clue_analysis
    .filter(c => {
      const rel = c.r ?? c.relevance_to_us
      return rel !== "N" && rel !== "neutral"
    })
    .slice(0, 12)
    .map(c => {
      const rel = c.r ?? (c.relevance_to_us === "supports" ? "S" : c.relevance_to_us === "weakens" ? "W" : "N")
      const use = c.use || c.how_we_use_it || ""
      const credAttack = c.credibility_attack ? ` | ATTACK: ${c.credibility_attack.slice(0, 80)}` : ""
      return `  [${c.clue_id}] ${rel}: ${use.slice(0, 100)}${credAttack}`
    })

  const attackLine = content.attack_strategy
    ? `ATTACK STRATEGY: ${content.attack_strategy}`
    : ""

  return [
    `YOUR CORE POSITION: ${content.our_core_position}`,
    `SCENARIO YOU ARE PUSHING: ${content.scenario_we_are_pushing}`,
    `STRONGEST OPPONENT: ${content.strongest_opposing_party}`,
    attackLine,
    `YOUR VULNERABILITIES: ${content.our_key_vulnerabilities.join("; ")}`,
    `YOUR OPENING MOVE: ${content.opening_move}`,
    `\nCLUE STRATEGY (non-neutral clues):`,
    ...clueLines,
  ].filter(Boolean).join("\n")
}

function buildCredibilityReference(topicId: string): string {
  const clues = dbGetClues(topicId)
  return clues.map(clue => {
    const cur = clue.versions.find(v => v.v === clue.current)!
    const cred = cur.source_credibility
    const fc = cur.fact_check
    const verdict = fc?.verdict?.toUpperCase() ?? "UNCHECKED"
    const biasStr = cred.bias_flags.length > 0 ? `, bias:${cred.bias_flags.slice(0, 2).join("+")}` : ""
    const outlet = cred.origin_sources?.[0]?.outlet ?? ""
    return `[${clue.id}] ${verdict}, cred:${cred.score}${biasStr}${outlet ? " — " + outlet : ""}`
  }).join("\n")
}

function formatRecentTurns(turns: ForumTurn[]): string {
  return turns.map(t =>
    `[Turn ${t.round} — ${t.party_name}]: ${t.statement}`
  ).join("\n\n---\n\n")
}

function formatScenarios(scenarios: ForumScenario[]): string {
  if (scenarios.length === 0) return "No scenarios defined yet."
  return scenarios.map(s =>
    `• ${s.title}: ${s.description} (supported by: ${s.supported_by.join(", ") || "none"}, contested by: ${s.contested_by.join(", ") || "none"})`
  ).join("\n")
}

export async function runRepresentativeTurn(input: RepTurnInput): Promise<RepTurnOutput> {
  const {
    topicId, runId, sessionId, partyId, personaTitle, model,
    turnNumber, myTurnCount, speakingWeight,
    recentTurns, compressedHistory, liveScenarios, topic,
    moderatorDirective,
  } = input

  const party = await getPartyProfile(topicId, partyId)
  const repId = `rep-${partyId}`

  // Load scratchpad
  const scratchpadRow = dbGetScratchpad(topicId, sessionId, repId)
  const scratchpadStr = scratchpadRow
    ? formatScratchpad(scratchpadRow.content)
    : `YOUR CORE POSITION: ${party.agenda}\nNo detailed preparation available.`

  // Build context
  const historyBlock = compressedHistory
    ? `DEBATE SUMMARY (earlier turns):\n${compressedHistory}\n\n`
    : ""

  const recentStr = formatRecentTurns(recentTurns)
  const scenariosStr = formatScenarios(liveScenarios)

  const directiveBlock = moderatorDirective
    ? `\nMODERATOR NOTE: ${moderatorDirective}\n`
    : ""

  const credibilityReference = buildCredibilityReference(topicId)

  const turnConfig = await resolvePrompt("forum/representative-turn", {
    persona_title: personaTitle,
    party_name: party.name,
    scratchpad: scratchpadStr,
    credibility_reference: credibilityReference,
    topic,
    live_scenarios: scenariosStr,
    conversation_history: historyBlock,
    recent_turns: recentStr,
    my_turn_count: String(myTurnCount),
    turn_number: String(turnNumber),
    speaking_weight: String(speakingWeight),
    moderator_directive: directiveBlock,
  })
  const effectiveModel = turnConfig.model ?? model

  const userContent = `Turn ${turnNumber}: It is your moment. Speak or pass.`

  const budget = budgetOutput(effectiveModel, turnConfig.content + userContent, { min: 300, max: 800 })

  let raw: string
  try {
    if (turnConfig.tools.length > 0) {
      raw = await runAgenticLoop({
        model: effectiveModel,
        topicId,
        stage: "forum",
        tools: turnConfig.tools,
        temperature: 0.7,
        max_tokens: budget,
        messages: [
          { role: "system", content: turnConfig.content },
          { role: "user", content: userContent },
        ],
      })
    } else {
      raw = await chatCompletionText({
        model: effectiveModel,
        messages: [
          { role: "system", content: turnConfig.content },
          { role: "user", content: userContent },
        ],
        temperature: 0.7,
        max_tokens: budget,
      })
    }
  } catch (e) {
    log.forum(`  ${partyId} turn failed: ${e}`)
    return { turn: null, passed: true }
  }

  // Parse output
  let action: "speak" | "pass" = "speak"
  let statement = ""
  let position: string | undefined
  let evidence: { claim: string; clue_id: string; interpretation: string }[] = []
  let challenges: { target_party: string; challenge: string; clue_id?: string }[] = []
  let concessions: string[] = []
  let cluesCited: string[] = []
  let scenarioSignal: string | undefined

  try {
    const cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "")
    const match = cleaned.match(/\{[\s\S]+\}/)
    if (match) {
      const parsed = JSON.parse(match[0])
      action = parsed.action === "pass" ? "pass" : "speak"
      statement = parsed.statement || ""
      position = parsed.position || undefined
      evidence = Array.isArray(parsed.evidence) ? parsed.evidence : []
      challenges = Array.isArray(parsed.challenges) ? parsed.challenges : []
      concessions = Array.isArray(parsed.concessions) ? parsed.concessions : []
      cluesCited = parsed.clues_cited || []
      scenarioSignal = parsed.scenario_signal || undefined
    } else {
      statement = raw.trim()
    }
  } catch {
    statement = raw.trim()
  }

  if (action === "pass") {
    log.forum(`  ${partyId} PASSED turn ${turnNumber}`)
    return { turn: null, passed: true }
  }

  // Extract inline clue citations from statement text
  const inlineCites = statement.match(/\[clue-\d+\]/g) ?? []
  const allCited = [...new Set([...cluesCited, ...inlineCites.map(m => m.replace(/[\[\]]/g, ""))])]

  // Also extract clue IDs from structured evidence/challenges
  const structuredCites = [
    ...evidence.map(e => e.clue_id).filter(Boolean),
    ...challenges.map(c => c.clue_id).filter((id): id is string => !!id),
  ]

  const allCitedFull = [...new Set([...allCited, ...structuredCites])]

  const turn: ForumTurn = {
    id: `turn-${partyId}-t${turnNumber}`,
    representative_id: repId,
    party_name: party.name,
    persona_title: personaTitle,
    statement,
    position,
    clues_cited: allCitedFull,
    scenario_endorsement: scenarioSignal,
    timestamp: new Date().toISOString(),
    round: turnNumber,
    type: "debate",
    word_count: countWords(statement),
    evidence,
    challenges,
    concessions,
  }

  await writeArtifact(topicId, runId, `turn_${partyId}_t${turnNumber}`, turn)
  log.forum(`  ${partyId} spoke (${turn.word_count}w, cited ${allCitedFull.length} clues): "${statement.slice(0, 80)}…"`)

  return { turn, passed: false }
}

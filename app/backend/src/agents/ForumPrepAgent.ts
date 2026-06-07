import { chatCompletionText } from "../llm/proxyClient"
import { budgetOutput } from "../llm/tokenBudget"
import { resolvePrompt } from "../llm/promptLoader"
import { runAgenticLoop } from "../llm/agenticLoop"
import { emitThink } from "../routes/stream"
import { log } from "../utils/logger"
import { dbGetParties } from "../db/queries/parties"
import { dbGetClues } from "../db/queries/clues"
import { dbGetRepresentatives } from "../db/queries/forum"
import { dbWriteScratchpad } from "../db/queries/forum"
import type { ScratchpadContent } from "../db/queries/forum"

export interface PrepResult {
  prepared: string[]  // representative_ids that got a scratchpad
}

export async function runForumPrepAgent(
  topicId: string,
  title: string,
  sessionId: string,
  model: string,
  onProgress?: (msg: string) => void
): Promise<PrepResult> {
  const representatives = dbGetRepresentatives(topicId)
  const parties = dbGetParties(topicId)
  const allClues = dbGetClues(topicId)

  if (!representatives.length) throw new Error("No representatives found — run Forum Prep first")

  log.forum(`ForumPrepAgent: preparing ${representatives.length} representatives`)
  emitThink(topicId, "📋", "Forum preparation", `${representatives.length} representatives reading evidence…`)

  // Build clue list with credibility intelligence
  const clueList = allClues.map(clue => {
    const cur = clue.versions.find(v => v.v === clue.current)!
    const cred = cur.source_credibility
    const fc = cur.fact_check
    const verdictTag = fc?.verdict ? fc.verdict.toUpperCase() : "UNCHECKED"
    const biasStr = cred.bias_flags.length > 0 ? `, bias:${cred.bias_flags.join("+")}` : ""
    const header = `[${clue.id}] [${verdictTag}, cred:${cred.score}${biasStr}] (${cur.clue_type}, ${cur.timeline_date})`
    const title = cur.title
    const summary = cur.bias_corrected_summary.slice(0, 200)
    const cuiBono = fc?.cui_bono ? `\n  Cui bono: ${fc.cui_bono.slice(0, 150)}` : ""
    return `${header}\n  ${title}: ${summary}${cuiBono}`
  }).join("\n")

  const prepared: string[] = []

  // All reps prepare in parallel — scratchpads are fully independent
  await Promise.all(representatives.map(async (rep) => {
    const party = parties.find(p => p.id === rep.party_id)
    if (!party) return

    const otherParties = parties
      .filter(p => p.id !== party.id)
      .map(p => {
        const means = p.means.slice(0, 3).map(m => `"${m}"`).join(", ")
        const vulns = p.vulnerabilities.slice(0, 2).map(v => `"${v}"`).join(", ")
        const allies = (p.circle?.visible ?? []).slice(0, 5).join(", ")
        return [
          `- ${p.name} (${p.type}):`,
          `  agenda="${p.agenda.slice(0, 120)}"`,
          `  stance=${p.stance}`,
          `  means=[${means}]`,
          `  vulnerabilities=[${vulns}]`,
          allies ? `  allies=[${allies}]` : "",
        ].filter(Boolean).join("\n")
      })
      .join("\n")

    onProgress?.(`Forum prep: ${party.name} reading evidence…`)
    emitThink(topicId, "🧠", `Prep · ${party.name}`, "Reading all clues, building strategy…")
    log.forum(`  Preparing ${party.name} (${allClues.length} clues to analyze)`)

    const scratchpadConfig = await resolvePrompt("forum/scratchpad", {
      party_name: party.name,
      party_type: party.type,
      agenda: party.agenda,
      means: party.means.slice(0, 5).join(", "),
      stance: party.stance,
      vulnerabilities: party.vulnerabilities.slice(0, 3).join(", "),
      other_parties: otherParties,
      clue_list: clueList,
    })
    const scratchpadModel = scratchpadConfig.model ?? model

    const budget = budgetOutput(scratchpadModel, scratchpadConfig.content, { min: 3000, max: 16000 })

    try {
      let raw: string
      if (scratchpadConfig.tools.length > 0) {
        raw = await runAgenticLoop({
          model: scratchpadModel,
          messages: [
            { role: "system", content: scratchpadConfig.content },
            { role: "user", content: `Prepare your private strategic notes for the upcoming forum on: "${title}"` },
          ],
          tools: scratchpadConfig.tools,
          topicId,
          stage: "forum",
          temperature: 0.4,
          max_tokens: budget,
        })
      } else {
        raw = await chatCompletionText({
          model: scratchpadModel,
          messages: [
            { role: "system", content: scratchpadConfig.content },
            { role: "user", content: `Prepare your private strategic notes for the upcoming forum on: "${title}"` },
          ],
          temperature: 0.4,
          max_tokens: budget,
        })
      }

      const match = raw.match(/\{[\s\S]+\}/)
      if (!match) throw new Error("No JSON object in scratchpad response")

      const content = JSON.parse(match[0]) as ScratchpadContent

      dbWriteScratchpad(topicId, {
        representative_id: rep.id,
        session_id: sessionId,
        topic_id: topicId,
        party_id: party.id,
        content,
        created_at: new Date().toISOString(),
      })

      prepared.push(rep.id)
      emitThink(topicId, "✅", `Ready · ${party.name}`, `Analyzed ${content.clue_analysis?.length ?? 0} clues · pushing: "${content.scenario_we_are_pushing?.slice(0, 60)}"`)
      log.forum(`  ${party.name} ready: analyzed ${content.clue_analysis?.length ?? 0} clues, pushing "${content.scenario_we_are_pushing?.slice(0, 60)}"`)
    } catch (e) {
      log.forum(`  Prep failed for ${party.name}: ${e}`)
      // Write minimal fallback scratchpad so the agent can still participate
      dbWriteScratchpad(topicId, {
        representative_id: rep.id,
        session_id: sessionId,
        topic_id: topicId,
        party_id: party.id,
        content: {
          clue_analysis: [],
          our_core_position: party.agenda,
          scenario_we_are_pushing: "outcome favorable to " + party.name,
          strongest_opposing_party: "",
          our_key_vulnerabilities: party.vulnerabilities.slice(0, 2),
          opening_move: "We will defend our position based on the available evidence.",
        },
        created_at: new Date().toISOString(),
      })
      prepared.push(rep.id)
    }
  }))

  log.forum(`ForumPrepAgent complete: ${prepared.length}/${representatives.length} prepared`)
  return { prepared }
}

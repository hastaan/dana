import { chatCompletionText } from "../llm/proxyClient"
import { budgetOutput } from "../llm/tokenBudget"
import { resolvePrompt } from "../llm/promptLoader"
import { runAgenticLoop } from "../llm/agenticLoop"
import { gatherResearch } from "../tools/research/gatherResearch"
import { log } from "../utils/logger"
import { emitThink } from "../routes/stream"
import type { Party } from "./DiscoveryAgent"

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30)
}

export async function smartAddParty(
  topicId: string,
  topicTitle: string,
  topicDescription: string,
  partyName: string,
  model: string,
  existingParties: Party[],
): Promise<Party> {
  log.discovery(`Smart add: researching "${partyName}" for topic "${topicTitle}"`)

  const research = await gatherResearch([
    `"${partyName}" role in ${topicTitle}`,
    `${partyName} political influence capabilities ${new Date().getFullYear()}`,
    `${partyName} alliances vulnerabilities geopolitical`,
  ], topicId, "discovery")

  const existingNames = existingParties.map(p => p.name).join(", ")

  const addConfig = await resolvePrompt("party-intelligence/add")
  const effectiveModel = addConfig.model ?? model

  const userContent = `TOPIC: ${topicTitle}
DESCRIPTION: ${topicDescription}
PARTY TO PROFILE: ${partyName}
EXISTING PARTIES: ${existingNames}

RESEARCH MATERIAL:
${research}

Generate a complete party profile for "${partyName}". Output ONLY valid JSON, no markdown fences.`

  let raw: string
  if (addConfig.tools.length > 0) {
    raw = await runAgenticLoop({
      model: effectiveModel,
      topicId,
      stage: "discovery",
      tools: addConfig.tools,
      temperature: 0.3,
      max_tokens: budgetOutput(effectiveModel, research + topicTitle, { min: 2000, max: 5000 }),
      messages: [
        { role: "system", content: addConfig.content },
        { role: "user", content: userContent },
      ],
    })
  } else {
    raw = await chatCompletionText({
      model: effectiveModel,
      messages: [
        { role: "system", content: addConfig.content },
        { role: "user", content: userContent },
      ],
      temperature: 0.3,
      max_tokens: budgetOutput(effectiveModel, research + topicTitle, { min: 2000, max: 5000 }),
    })
  }

  const match = raw.match(/\{[\s\S]+\}/)
  if (!match) throw new Error("Failed to parse party JSON from LLM response")
  const party = JSON.parse(match[0]) as Party
  party.id = party.id || slugify(partyName)
  party.auto_discovered = false
  party.user_verified = true

  log.discovery(`Smart add complete: ${party.name} (w=${party.weight})`)
  return party
}

export async function smartEditParty(
  topicId: string,
  topicTitle: string,
  currentParty: Party,
  feedback: string,
  model: string,
): Promise<Party> {
  log.discovery(`Smart edit: "${currentParty.name}" — "${feedback.slice(0, 80)}"`)
  emitThink(topicId, "📝", `Smart edit: ${currentParty.name}`, feedback.slice(0, 100))

  const editConfig = await resolvePrompt("party-intelligence/edit")

  const raw = await runAgenticLoop({
    model: editConfig.model ?? model,
    topicId,
    stage: "discovery",
    tools: editConfig.tools,
    temperature: 0.3,
    max_tokens: budgetOutput(editConfig.model ?? model, JSON.stringify(currentParty) + feedback, { min: 2000, max: 5000 }),
    messages: [
      {
        role: "system",
        content: editConfig.content,
      },
      {
        role: "user",
        content: `TOPIC: ${topicTitle}

CURRENT PARTY PROFILE:
${JSON.stringify(currentParty, null, 2)}

USER FEEDBACK:
${feedback}

Research the feedback using the available tools, then output the updated party profile as valid JSON (no markdown fences).`,
      },
    ],
  })

  const match = raw.match(/\{[\s\S]+\}/)
  if (!match) throw new Error("Failed to parse party JSON from LLM response")
  const updated = JSON.parse(match[0]) as Party
  updated.id = currentParty.id
  updated.auto_discovered = false
  updated.user_verified = true

  emitThink(topicId, "✅", `Smart edit complete: ${updated.name}`)
  log.discovery(`Smart edit complete: ${updated.name}`)
  return updated
}

export async function smartSplitParty(
  topicId: string,
  topicTitle: string,
  sourceParty: Party,
  splitNames: string[],
  model: string,
): Promise<Party[]> {
  log.discovery(`Smart split: splitting "${sourceParty.name}" into ${splitNames.join(", ")}`)

  const research = await gatherResearch(
    splitNames.map(n => `"${n}" role capabilities ${topicTitle}`),
    topicId, "discovery"
  )

  const splitConfig = await resolvePrompt("party-intelligence/split")
  const effectiveModel = splitConfig.model ?? model

  const userContent = `TOPIC: ${topicTitle}

ORIGINAL PARTY:
${JSON.stringify(sourceParty, null, 2)}

SPLIT INTO THESE PARTIES: ${splitNames.join(", ")}

RESEARCH MATERIAL:
${research}

Generate a complete profile for each sub-party. Output ONLY a valid JSON array, no markdown fences.`

  let raw: string
  if (splitConfig.tools.length > 0) {
    raw = await runAgenticLoop({
      model: effectiveModel,
      topicId,
      stage: "discovery",
      tools: splitConfig.tools,
      temperature: 0.3,
      max_tokens: budgetOutput(effectiveModel, JSON.stringify(sourceParty) + research, { min: 3000, max: Math.max(splitNames.length * 2000, 6000) }),
      messages: [
        { role: "system", content: splitConfig.content },
        { role: "user", content: userContent },
      ],
    })
  } else {
    raw = await chatCompletionText({
      model: effectiveModel,
      messages: [
        { role: "system", content: splitConfig.content },
        { role: "user", content: userContent },
      ],
      temperature: 0.3,
      max_tokens: budgetOutput(effectiveModel, JSON.stringify(sourceParty) + research, { min: 3000, max: Math.max(splitNames.length * 2000, 6000) }),
    })
  }

  const match = raw.match(/\[[\s\S]+\]/)
  if (!match) throw new Error("Failed to parse split parties JSON from LLM response")
  const parties = JSON.parse(match[0]) as Party[]

  for (const p of parties) {
    p.id = p.id || slugify(p.name)
    p.auto_discovered = false
    p.user_verified = true
  }

  log.discovery(`Smart split complete: ${parties.map(p => `${p.name} (w=${p.weight})`).join(", ")}`)
  return parties
}

export async function smartMergeParties(
  topicTitle: string,
  sources: Party[],
  targetName: string,
  model: string,
): Promise<Partial<Party>> {
  log.discovery(`Smart merge: merging ${sources.map(s => s.name).join(", ")} into "${targetName}"`)

  const mergeConfig = await resolvePrompt("party-intelligence/merge")
  const effectiveModel = mergeConfig.model ?? model

  const raw = await chatCompletionText({
    model: effectiveModel,
    messages: [
      {
        role: "system",
        content: mergeConfig.content,
      },
      {
        role: "user",
        content: `TOPIC: ${topicTitle}

PARTIES TO MERGE:
${sources.map(s => JSON.stringify(s, null, 2)).join("\n\n")}

MERGED PARTY NAME: ${targetName}

Synthesize a single party profile. Output ONLY valid JSON, no markdown fences.`,
      },
    ],
    temperature: 0.3,
    max_tokens: budgetOutput(effectiveModel, sources.map(s => JSON.stringify(s)).join(""), { min: 2000, max: 5000 }),
  })

  const match = raw.match(/\{[\s\S]+\}/)
  if (!match) throw new Error("Failed to parse merged party JSON from LLM response")
  const merged = JSON.parse(match[0]) as Party
  merged.id = slugify(targetName)
  merged.auto_discovered = false
  merged.user_verified = true

  log.discovery(`Smart merge complete: ${merged.name} (w=${merged.weight})`)
  return merged
}

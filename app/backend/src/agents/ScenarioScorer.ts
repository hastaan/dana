import { chatCompletionText } from "../llm/proxyClient"
import { runAgenticLoop } from "../llm/agenticLoop"
import { budgetOutput, fitContext } from "../llm/tokenBudget"
import { resolvePrompt } from "../llm/promptLoader"
import { log } from "../utils/logger"
import { emit, emitThink } from "../routes/stream"
import { dbGetParties } from "../db/queries/parties"
import { dbGetClues } from "../db/queries/clues"
import { dbGetAllScratchpads } from "../db/queries/forum"
import { getForumSession } from "../tools/internal/getForumData"
import { dbSaveExpertCouncil } from "../db/queries/expert"
import { dbGetTopic } from "../db/queries/topics"
import { writeArtifact } from "../tools/internal/artifactStore"
import { steeringBlock, guidanceSnapshot } from "../llm/steering"
import { dbGetControls } from "../db/queries/settings"
import type { ForumScenario, ForumTurn, ScratchpadContent } from "../db/queries/forum"
import type { Party } from "../db/queries/parties"
import type { ExpertCouncilOutput, FinalVerdict, RankedScenario } from "./ExpertAgent"

// ─── Evidence map types ───────────────────────────────────────────────────────

interface ClueEvidence {
  clue_id: string
  title: string
  clue_type: string
  credibility: number            // raw source credibility (0–100)
  adjusted_credibility: number   // post-fact-check adjusted credibility
  relevance: number              // relevance to topic (0–100)
  bias_flags: string[]
  effective_weight: number       // adjusted_credibility × (relevance/100), penalized per bias flag
  summary: string
  key_points: string[]           // specific verifiable facts from the clue
  cited_in_turns: number         // how many debate turns cited this clue
  source_domains: string[]       // normalized origin domains/outlets — for independence clustering
  fact_check_verdict?: string    // verified/misleading/disputed/unverifiable
  bias_analysis?: string         // fact-checker's bias analysis
  counter_evidence?: string      // contradicting evidence found by fact-checker
  cui_bono?: string              // who benefits from this being believed
}

interface ScenarioEvidence {
  scenario_id: string
  title: string
  description: string
  supporting_clues: ClueEvidence[]
  contesting_clues: ClueEvidence[]
  forum_for: { party_id: string; party_name: string; weight: number; turn_count: number }[]
  forum_against: { party_id: string; party_name: string; weight: number; turn_count: number }[]
  scratchpad_pushers: { party_id: string; party_name: string; weight: number; scenario_push: string }[]
  scratchpad_resisters: { party_id: string; party_name: string; weight: number; vulnerability: string }[]
  net_power_projection: number   // positive = favored by high-weight parties
  evidence_density: number       // raw sum of supporting effective weights (can double-count correlated sources)
  independent_evidence_density: number  // sum after collapsing correlated sources (one wire echoed by N outlets ≈ 1)
  source_cluster_count: number   // number of independent source clusters backing this scenario
}

// ─── Pass 1: Build evidence map (no LLM) ─────────────────────────────────────

function computeEffectiveWeight(adjustedCredibility: number, relevance: number, biasFlags: string[]): number {
  // Base: post-fact-check credibility scaled by topic relevance
  // Each bias flag deducts 5 points (meaningful penalty, not cosmetic 0.1)
  const penalized = adjustedCredibility - biasFlags.length * 5
  const clamped = Math.max(10, penalized)
  return Math.round(clamped * (relevance / 100) * 10) / 10
}

function normDomain(u: string): string {
  try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase() }
  catch { return (u || "").toLowerCase().trim() }
}

// Evidence-independence: collapse clues that share a PRIMARY source origin so many
// clues from the same origin count as one confirmation. We cluster by each clue's
// primary domain only (not every domain) — unioning on any shared domain lets a
// multi-sourced clue (one that cites several outlets) transitively bridge and erase
// genuinely independent corroboration, which would make the scorer under-confident.
// Independent density = sum over clusters of the strongest clue's effective_weight.
// Limitation: a single wire story republished across DIFFERENT outlet domains is not
// collapsed (no reliable wire-origin metadata); the fact-checker's bias flags / cui
// bono handle that amplification separately.
function independentDensity(clues: ClueEvidence[]): { density: number; clusters: number } {
  const clusterMax = new Map<string, number>()
  clues.forEach((c, i) => {
    const key = c.source_domains.find(Boolean) || `__solo_${i}` // primary origin; none → own cluster
    clusterMax.set(key, Math.max(clusterMax.get(key) ?? 0, c.effective_weight))
  })
  let density = 0
  for (const m of clusterMax.values()) density += m
  return { density: Math.round(density * 10) / 10, clusters: clusterMax.size }
}

type ClueMapEntry = {
  title: string
  clue_type: string
  credibility: number
  adjusted_credibility: number
  relevance: number
  bias_flags: string[]
  summary: string
  key_points: string[]
  source_domains: string[]
  fact_check_verdict?: string
  bias_analysis?: string
  counter_evidence?: string
  cui_bono?: string
}

function buildEvidenceMap(
  scenarios: ForumScenario[],
  allTurns: ForumTurn[],
  scratchpads: { party_id: string; content: ScratchpadContent }[],
  parties: Party[],
  clueMap: Map<string, ClueMapEntry>,
): ScenarioEvidence[] {
  const partyMap = new Map(parties.map(p => [p.id, p]))
  // Defensive: also build name → id map to handle legacy data where supported_by stored names not IDs
  const partyNameToId = new Map(parties.map(p => [p.name.toLowerCase().trim(), p.id]))

  function resolvePartyId(nameOrId: string): string {
    if (partyMap.has(nameOrId)) return nameOrId
    return partyNameToId.get(nameOrId.toLowerCase().trim()) ?? nameOrId
  }

  // Build turn citation index: clue_id → [party_id list]
  const clueCitedBy = new Map<string, string[]>()
  for (const turn of allTurns) {
    for (const cId of turn.clues_cited) {
      if (!clueCitedBy.has(cId)) clueCitedBy.set(cId, [])
      clueCitedBy.get(cId)!.push(turn.party_id ?? turn.representative_id.replace("rep-", ""))
    }
  }

  // Build per-party turn count index
  const partyTurnCount = new Map<string, number>()
  for (const turn of allTurns) {
    const pid = turn.party_id ?? turn.representative_id.replace("rep-", "")
    partyTurnCount.set(pid, (partyTurnCount.get(pid) ?? 0) + 1)
  }

  return scenarios.map(sc => {
    const scClueIds = new Set(sc.clues_cited)

    // Collect all clue IDs cited in turns by parties who supported/contested this scenario
    // Normalize: resolve both IDs and legacy names to canonical party IDs
    const supportingPartyIds = new Set(sc.supported_by.map(resolvePartyId))
    const contestingPartyIds = new Set(sc.contested_by.map(resolvePartyId))

    // Augment scenario clues with clues from supporting parties' turns
    for (const turn of allTurns) {
      const pid = turn.party_id ?? turn.representative_id.replace("rep-", "")
      if (supportingPartyIds.has(pid)) {
        for (const cId of turn.clues_cited) scClueIds.add(cId)
      }
    }

    // Build supporting clue evidence
    const supportingClues: ClueEvidence[] = []
    for (const cId of scClueIds) {
      const clue = clueMap.get(cId)
      if (!clue) continue
      supportingClues.push({
        clue_id: cId,
        title: clue.title,
        clue_type: clue.clue_type,
        credibility: clue.credibility,
        adjusted_credibility: clue.adjusted_credibility,
        relevance: clue.relevance,
        bias_flags: clue.bias_flags,
        effective_weight: computeEffectiveWeight(clue.adjusted_credibility, clue.relevance, clue.bias_flags),
        summary: clue.summary,
        key_points: clue.key_points,
        cited_in_turns: (clueCitedBy.get(cId) ?? []).length,
        source_domains: clue.source_domains,
        fact_check_verdict: clue.fact_check_verdict,
        bias_analysis: clue.bias_analysis,
        counter_evidence: clue.counter_evidence,
        cui_bono: clue.cui_bono,
      })
    }

    // Build contesting clue evidence (clues cited by contesting parties but not in sc.clues_cited)
    const contestingClues: ClueEvidence[] = []
    for (const turn of allTurns) {
      const pid = turn.party_id ?? turn.representative_id.replace("rep-", "")
      if (!contestingPartyIds.has(pid)) continue
      for (const cId of turn.clues_cited) {
        if (scClueIds.has(cId)) continue // already counted as supporting
        const clue = clueMap.get(cId)
        if (!clue) continue
        if (contestingClues.some(c => c.clue_id === cId)) continue // dedup
        contestingClues.push({
          clue_id: cId,
          title: clue.title,
          clue_type: clue.clue_type,
          credibility: clue.credibility,
          adjusted_credibility: clue.adjusted_credibility,
          relevance: clue.relevance,
          bias_flags: clue.bias_flags,
          effective_weight: computeEffectiveWeight(clue.adjusted_credibility, clue.relevance, clue.bias_flags),
          summary: clue.summary,
          key_points: clue.key_points,
          cited_in_turns: (clueCitedBy.get(cId) ?? []).length,
          source_domains: clue.source_domains,
          fact_check_verdict: clue.fact_check_verdict,
          bias_analysis: clue.bias_analysis,
          counter_evidence: clue.counter_evidence,
          cui_bono: clue.cui_bono,
        })
      }
    }

    // Forum participation: who argued for/against (normalize to canonical IDs)
    const forumFor = sc.supported_by.map(raw => {
      const pid = resolvePartyId(raw)
      const party = partyMap.get(pid)
      return { party_id: pid, party_name: party?.name ?? raw, weight: party?.weight ?? 0, turn_count: partyTurnCount.get(pid) ?? 0 }
    })
    const forumAgainst = sc.contested_by.map(raw => {
      const pid = resolvePartyId(raw)
      const party = partyMap.get(pid)
      return { party_id: pid, party_name: party?.name ?? raw, weight: party?.weight ?? 0, turn_count: partyTurnCount.get(pid) ?? 0 }
    })

    // Scratchpad intelligence
    const scratchpadPushers: ScenarioEvidence["scratchpad_pushers"] = []
    const scratchpadResisters: ScenarioEvidence["scratchpad_resisters"] = []

    for (const pad of scratchpads) {
      const party = partyMap.get(pad.party_id)
      if (!party) continue
      const push = pad.content.scenario_we_are_pushing ?? ""
      const vulns = pad.content.our_key_vulnerabilities ?? []
      const scTitle = sc.title.toLowerCase()

      // Check if this party's scratchpad scenario aligns with this scenario
      const pushLower = push.toLowerCase()
      if (pushLower.length > 0 && (
        scTitle.split(" ").filter(w => w.length > 4).some(w => pushLower.includes(w)) ||
        sc.benefiting_parties.includes(pad.party_id)
      )) {
        scratchpadPushers.push({ party_id: pad.party_id, party_name: party.name, weight: party.weight, scenario_push: push.slice(0, 150) })
      }

      // Check if this party listed a vulnerability related to this scenario
      for (const vuln of vulns) {
        if (scTitle.split(" ").filter(w => w.length > 4).some(w => vuln.toLowerCase().includes(w))) {
          scratchpadResisters.push({ party_id: pad.party_id, party_name: party.name, weight: party.weight, vulnerability: vuln.slice(0, 100) })
          break
        }
      }
    }

    // Net power projection: backing weight - blocking weight
    const backingWeight = [
      ...forumFor.map(p => p.weight),
      ...scratchpadPushers.map(p => p.weight),
    ].reduce((s, w) => s + w, 0)

    const blockingWeight = [
      ...forumAgainst.map(p => p.weight),
      ...scratchpadResisters.map(p => p.weight),
    ].reduce((s, w) => s + w, 0)

    const netPowerProjection = backingWeight - blockingWeight

    // Evidence density: raw sum of supporting effective weights (double-counts echoes)
    const evidenceDensity = supportingClues.reduce((s, c) => s + c.effective_weight, 0)
    // Independence-adjusted: collapse correlated sources so amplified/echoed claims
    // don't inflate confidence (fights fake-news amplification).
    const { density: independentEvidenceDensity, clusters: sourceClusterCount } = independentDensity(supportingClues)

    return {
      scenario_id: sc.id,
      title: sc.title,
      description: sc.description,
      supporting_clues: supportingClues,
      contesting_clues: contestingClues,
      forum_for: forumFor,
      forum_against: forumAgainst,
      scratchpad_pushers: scratchpadPushers,
      scratchpad_resisters: scratchpadResisters,
      net_power_projection: netPowerProjection,
      evidence_density: evidenceDensity,
      independent_evidence_density: independentEvidenceDensity,
      source_cluster_count: sourceClusterCount,
    }
  })
}

// ─── Pass 2: LLM probability scoring ─────────────────────────────────────────

function serializeEvidenceMap(evidenceMap: ScenarioEvidence[], parties: Party[]): string {
  const partyMap = new Map(parties.map(p => [p.id, p]))

  const sections: string[] = []

  for (const sc of evidenceMap) {
    const lines = [
      `=== SCENARIO: ${sc.scenario_id} — "${sc.title}" ===`,
      `Description: ${sc.description}`,
      `Net power projection: ${sc.net_power_projection > 0 ? "+" : ""}${Math.round(sc.net_power_projection)} (positive = backed by high-weight parties)`,
      `Evidence density (raw): ${sc.evidence_density.toFixed(2)}`,
      `Evidence density (independent): ${sc.independent_evidence_density.toFixed(2)} across ${sc.source_cluster_count} independent source cluster(s) — USE THIS; the raw figure may double-count outlets echoing the same origin.`,
    ]

    if (sc.supporting_clues.length > 0) {
      lines.push(`\nSUPPORTING CLUES (${sc.supporting_clues.length}):`)
      for (const c of sc.supporting_clues) {
        const verdict = c.fact_check_verdict ? ` | verdict=${c.fact_check_verdict.toUpperCase()}` : ""
        const credStr = c.adjusted_credibility !== c.credibility
          ? `raw_cred=${c.credibility} → adj_cred=${c.adjusted_credibility}`
          : `credibility=${c.credibility}`
        lines.push(`  [${c.clue_id}] ${c.title}`)
        lines.push(`    type=${c.clue_type} | ${credStr} | relevance=${c.relevance}${verdict} | effective_weight=${c.effective_weight} | cited_in_${c.cited_in_turns}_turns`)
        if (c.bias_flags.length > 0) lines.push(`    Bias flags: ${c.bias_flags.join("; ")}`)
        lines.push(`    Summary: ${c.summary.slice(0, 150)}`)
        if (c.key_points.length > 0) lines.push(`    Key facts: ${c.key_points.slice(0, 4).map(kp => kp.slice(0, 100)).join(" | ")}`)
        if (c.bias_analysis) lines.push(`    Bias analysis: ${c.bias_analysis.slice(0, 150)}`)
        if (c.counter_evidence) lines.push(`    Counter-evidence: ${c.counter_evidence.slice(0, 150)}`)
        if (c.cui_bono) lines.push(`    Cui bono: ${c.cui_bono.slice(0, 100)}`)
      }
    }

    if (sc.contesting_clues.length > 0) {
      lines.push(`\nCONTESTING CLUES (${sc.contesting_clues.length}):`)
      for (const c of sc.contesting_clues) {
        const verdict = c.fact_check_verdict ? ` | verdict=${c.fact_check_verdict.toUpperCase()}` : ""
        lines.push(`  [${c.clue_id}] ${c.title}`)
        lines.push(`    credibility=${c.adjusted_credibility} | relevance=${c.relevance}${verdict} | effective_weight=${c.effective_weight}`)
        lines.push(`    Summary: ${c.summary.slice(0, 120)}`)
        if (c.key_points.length > 0) lines.push(`    Key facts: ${c.key_points.slice(0, 3).map(kp => kp.slice(0, 80)).join(" | ")}`)
        if (c.counter_evidence) lines.push(`    Counter-evidence: ${c.counter_evidence.slice(0, 120)}`)
        if (c.cui_bono) lines.push(`    Cui bono: ${c.cui_bono.slice(0, 80)}`)
      }
    }

    if (sc.forum_for.length > 0) {
      lines.push(`\nFORUM BACKING:`)
      for (const p of sc.forum_for) {
        const party = partyMap.get(p.party_id)
        const allies = party?.circle?.visible?.slice(0, 3).join(", ") ?? "none"
        lines.push(`  ${p.party_name} (weight=${p.weight}, turns=${p.turn_count}, allies=[${allies}])`)
      }
    }

    if (sc.forum_against.length > 0) {
      lines.push(`\nFORUM OPPOSITION:`)
      for (const p of sc.forum_against) {
        lines.push(`  ${p.party_name} (weight=${p.weight}, turns=${p.turn_count})`)
      }
    }

    if (sc.scratchpad_pushers.length > 0) {
      lines.push(`\nSCRATCHPAD INTEL — PRIVATELY PUSHING THIS SCENARIO:`)
      for (const p of sc.scratchpad_pushers) {
        lines.push(`  ${p.party_name} (weight=${p.weight}): "${p.scenario_push}"`)
      }
    }

    if (sc.scratchpad_resisters.length > 0) {
      lines.push(`\nSCRATCHPAD INTEL — PRIVATELY VULNERABLE TO THIS SCENARIO:`)
      for (const p of sc.scratchpad_resisters) {
        lines.push(`  ${p.party_name} (weight=${p.weight}): "${p.vulnerability}"`)
      }
    }

    sections.push(lines.join("\n"))
  }

  const partySection = [
    "\n=== PARTY REGISTRY ===",
    ...parties.map(p => {
      const allies = [...(p.circle?.visible ?? []), ...(p.circle?.shadow ?? [])].slice(0, 4).join(", ")
      return `${p.name} (id=${p.id}, weight=${p.weight}, stance=${p.stance}, allies/shadow=[${allies}])`
    }),
  ].join("\n")

  return sections.join("\n\n") + "\n\n" + partySection
}

// ─── Ensemble aggregation ─────────────────────────────────────────────────────

function aggregateEnsemble(
  runs: { scenarios_ranked: RankedScenario[]; final_assessment: string; confidence_note: string }[],
): { scenarios_ranked: RankedScenario[]; final_assessment: string; confidence_note: string } {
  const round = (n: number) => Math.round(n * 1000) / 1000
  const N = runs.length

  // Normalize each run to sum 1.0 first, so per-run estimates (and the mean/range we
  // derive) are on a consistent scale and the means sum to ~1.0 (no post-hoc rescale
  // that would desync probability_range from the point estimate).
  const normRuns = runs.map(r => {
    const total = r.scenarios_ranked.reduce((s, x) => s + (typeof x.probability === "number" ? x.probability : 0), 0)
    const scale = total > 0 ? 1 / total : 0
    const byId = new Map<string, number>()
    for (const x of r.scenarios_ranked) byId.set(x.scenario_id, (typeof x.probability === "number" ? x.probability : 0) * scale)
    return byId
  })

  // Union of all scenario ids across all runs (never drop one only some runs produced).
  // Metadata (title, drivers, base_rate, resolution criteria…) from the first run with it.
  const meta = new Map<string, RankedScenario>()
  for (const r of runs) for (const s of r.scenarios_ranked) if (!meta.has(s.scenario_id)) meta.set(s.scenario_id, s)

  let divergent = false
  const merged = [...meta.keys()].map(id => {
    // A run that omitted this scenario implicitly scored it ~0 → consistent denominator N.
    const arr = normRuns.map(run => run.get(id) ?? 0)
    if (arr.some(p => p === 0) && !normRuns.every(run => run.has(id))) divergent = true
    const mean = arr.reduce((a, b) => a + b, 0) / N
    return {
      ...(meta.get(id) as RankedScenario),
      probability: round(mean),
      probability_range: { low: round(Math.min(...arr)), high: round(Math.max(...arr)) },
    }
  })

  if (divergent) log.expert("Scorer: ensemble runs returned differing scenario sets — missing entries counted as 0")

  return {
    scenarios_ranked: merged,
    final_assessment: runs[0].final_assessment,
    confidence_note: `${runs[0].confidence_note}\n\n[Ensemble of ${N} runs: probabilities are means of per-run normalized estimates; ranges show run-to-run spread — wider = less stable.]`,
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function runScenarioScorer(
  topicId: string,
  runId: string,
  sessionId: string,
  model: string,
  onProgress?: (msg: string) => void,
  version?: number,
): Promise<ExpertCouncilOutput> {
  const scorerConfig = await resolvePrompt("scoring/score-scenarios")
  const effectiveModel = scorerConfig.model ?? model
  const SCORER_PROMPT = scorerConfig.content + steeringBlock(topicId, "evidence")

  log.separator()
  log.expert("Stage 5/5: SCENARIO SCORER starting")

  emitThink(topicId, "🔬", "Scenario Scorer", "Building evidence map from all sources")
  emit(topicId, { type: "progress", stage: "expert_council", pct: 0.1, msg: "Building evidence map..." })

  // Load all data
  const [session, parties, rawClues, scratchpads] = await Promise.all([
    getForumSession(topicId, sessionId),
    Promise.resolve(dbGetParties(topicId)),
    Promise.resolve(dbGetClues(topicId)),
    Promise.resolve(dbGetAllScratchpads(topicId, sessionId)),
  ])

  const allTurns = session.rounds.flatMap(r => r.turns)
  const scenarios = session.scenarios

  if (scenarios.length === 0) throw new Error("No scenarios found in forum session — cannot score")

  // Build clue lookup map with full evidence richness
  const clueMap = new Map<string, ClueMapEntry>()
  for (const clue of rawClues) {
    const v = clue.versions[clue.current - 1] ?? clue.versions[clue.versions.length - 1]
    if (!v) continue
    const rawCredibility = v.source_credibility.score
    const adjustedCredibility = v.fact_check?.adjusted_credibility ?? rawCredibility
    // Source origins for independence clustering: domains from source URLs + outlet names.
    const domains = new Set<string>()
    for (const u of (v.raw_source?.urls ?? [])) domains.add(normDomain(u))
    for (const os of (v.source_credibility?.origin_sources ?? [])) {
      if (os.url) domains.add(normDomain(os.url))
      if (os.outlet) domains.add(os.outlet.toLowerCase().trim())
    }
    clueMap.set(clue.id, {
      title: v.title,
      clue_type: v.clue_type,
      credibility: rawCredibility,
      adjusted_credibility: adjustedCredibility,
      relevance: v.relevance_score ?? 50,
      bias_flags: v.fact_check?.adjusted_bias_flags ?? v.source_credibility.bias_flags,
      summary: v.bias_corrected_summary,
      key_points: v.key_points ?? [],
      source_domains: [...domains].filter(Boolean),
      fact_check_verdict: v.fact_check?.verdict,
      bias_analysis: v.fact_check?.bias_analysis,
      counter_evidence: v.fact_check?.counter_evidence,
      cui_bono: v.fact_check?.cui_bono,
    })
  }

  onProgress?.("Scorer: evidence map built")
  log.expert(`Scorer: ${scenarios.length} scenarios, ${allTurns.length} turns, ${scratchpads.length} scratchpads, ${rawClues.length} clues`)

  // Pass 1: Build structured evidence map (no LLM)
  const evidenceMap = buildEvidenceMap(scenarios, allTurns, scratchpads, parties, clueMap)

  log.expert(`Scorer: evidence map ready — power projections: ${evidenceMap.map(e => `${e.scenario_id}=${Math.round(e.net_power_projection)}`).join(", ")}`)
  emitThink(topicId, "📊", "Evidence map complete", `${scenarios.length} scenarios mapped`)

  // Pass 2: LLM probability scoring
  emit(topicId, { type: "progress", stage: "expert_council", pct: 0.4, msg: "Scoring scenario probabilities..." })
  onProgress?.("Scorer: running probability scoring")

  const evidenceStr = serializeEvidenceMap(evidenceMap, parties)

  const userPrompt = fitContext([
    { content: `TOPIC: ${topicId}`, priority: 5, label: "topic" },
    { content: `EVIDENCE PACKAGE:\n${evidenceStr}`, priority: 10, label: "evidence" },
    { content: `\nScore all ${scenarios.length} scenarios. Probabilities must sum to exactly 1.0.`, priority: 10, label: "instruction" },
  ], 80_000)

  const budget = budgetOutput(effectiveModel, SCORER_PROMPT + userPrompt, { min: 4000, max: 12000 })

  type ScoredVerdict = { scenarios_ranked: RankedScenario[]; final_assessment: string; confidence_note: string }

  // One scoring pass with up to 3 JSON-parse retries. Returns null if all fail.
  const scoreOnce = async (temperature: number): Promise<ScoredVerdict | null> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      let raw: string
      if (scorerConfig.tools.length > 0) {
        raw = await runAgenticLoop({
          model: effectiveModel,
          messages: [{ role: "system", content: SCORER_PROMPT }, { role: "user", content: userPrompt }],
          tools: scorerConfig.tools, topicId, stage: "expert", temperature, max_tokens: budget,
        })
      } else {
        raw = await chatCompletionText({
          model: effectiveModel,
          messages: [{ role: "system", content: SCORER_PROMPT }, { role: "user", content: userPrompt }],
          temperature, max_tokens: budget,
        })
      }
      try {
        const match = raw.match(/\{[\s\S]+\}/)
        if (!match) throw new Error("No JSON object found")
        const parsed = JSON.parse(match[0])
        if (!Array.isArray(parsed.scenarios_ranked)) throw new Error("Missing scenarios_ranked array")
        return parsed as ScoredVerdict
      } catch (e) {
        log.error("SCORER", `Attempt ${attempt + 1} failed`, e)
      }
    }
    return null
  }

  const ensembleRuns = Math.max(1, dbGetControls().scoring_ensemble_runs ?? 1)
  let verdict: ScoredVerdict | null = null

  if (ensembleRuns <= 1) {
    verdict = await scoreOnce(0.2)
    if (!verdict) throw new Error("Scenario scorer failed after 3 attempts")
  } else {
    // Ensemble: N independent runs at higher temperature → mean ± spread per scenario.
    emitThink(topicId, "🎲", `Ensemble scoring`, `${ensembleRuns} independent runs for uncertainty bands`)
    const runs: ScoredVerdict[] = []
    for (let i = 0; i < ensembleRuns; i++) {
      onProgress?.(`Scorer: ensemble run ${i + 1}/${ensembleRuns}`)
      const v = await scoreOnce(0.4)
      if (v) runs.push(v)
    }
    if (runs.length === 0) throw new Error("Scenario scorer failed across all ensemble runs")
    verdict = aggregateEnsemble(runs)
    log.expert(`Scorer: aggregated ${runs.length}/${ensembleRuns} ensemble runs`)
  }

  // Normalize probabilities to exactly 1.0 (guard against zero/negative totals from
  // malformed model output, which would otherwise yield NaN/sign-flipped values).
  const rawTotal = verdict.scenarios_ranked.reduce((s, r) => s + r.probability, 0)
  if (rawTotal <= 0) {
    const uniform = Math.round((1 / verdict.scenarios_ranked.length) * 1000) / 1000
    for (const r of verdict.scenarios_ranked) r.probability = uniform
  } else if (Math.abs(rawTotal - 1.0) > 0.01) {
    const scale = 1.0 / rawTotal
    for (const r of verdict.scenarios_ranked) {
      r.probability = Math.round(r.probability * scale * 1000) / 1000
      // Keep the ensemble uncertainty band on the same scale as the point estimate.
      if (r.probability_range) {
        r.probability_range = {
          low: Math.round(r.probability_range.low * scale * 1000) / 1000,
          high: Math.round(r.probability_range.high * scale * 1000) / 1000,
        }
      }
    }
    // Adjust last entry for floating point remainder
    const adjustedTotal = verdict.scenarios_ranked.reduce((s, r) => s + r.probability, 0)
    verdict.scenarios_ranked[verdict.scenarios_ranked.length - 1].probability =
      Math.round((verdict.scenarios_ranked[verdict.scenarios_ranked.length - 1].probability + (1.0 - adjustedTotal)) * 1000) / 1000
  }

  // Sort descending
  verdict.scenarios_ranked.sort((a, b) => b.probability - a.probability)

  // Augment each ranked scenario with deterministic power_balance from evidence map
  for (const ranked of verdict.scenarios_ranked) {
    const ev = evidenceMap.find(e => e.scenario_id === ranked.scenario_id)
    if (ev) {
      const backingWeight = ev.forum_for.reduce((s, p) => s + p.weight, 0)
      const opposingWeight = ev.forum_against.reduce((s, p) => s + p.weight, 0)
      ranked.power_balance = {
        backing_parties: ev.forum_for.map(p => ({ party_id: p.party_id, party_name: p.party_name, weight: p.weight })),
        opposing_parties: ev.forum_against.map(p => ({ party_id: p.party_id, party_name: p.party_name, weight: p.weight })),
        net_power: ev.net_power_projection,
        forum_support_ratio: `${ev.forum_for.length}:${ev.forum_against.length}`,
        weight_adjusted_ratio: `${backingWeight}:${opposingWeight}`,
        explanation: ranked.power_balance?.explanation ?? "",
      }
    }
  }

  const finalVerdict: FinalVerdict = {
    synthesized_at: new Date().toISOString(),
    scenarios_ranked: verdict.scenarios_ranked,
    final_assessment: verdict.final_assessment,
    confidence_note: verdict.confidence_note,
    weight_challenge_decisions: [],
    debate_summary: session.debate_summary,
    steering: guidanceSnapshot(topicId),
  }

  // Determine version — prefer passed version, fallback to extraction from runId
  let effectiveVersion = version ?? 1
  if (!version) {
    try {
      const topic = dbGetTopic(topicId)
      if (topic) effectiveVersion = Math.max(effectiveVersion, (topic.current_version || 0))
    } catch { /* use default */ }
    const vMatch = runId.match(/v(\d+)/)
    if (vMatch) effectiveVersion = parseInt(vMatch[1])
  }

  const councilOutput: ExpertCouncilOutput = {
    version: effectiveVersion,
    verdict_id: `verdict-v${effectiveVersion}`,
    experts: [],         // no expert personas — single scorer
    deliberations: [],   // no per-expert artifacts
    final_verdict: finalVerdict,
    evidence_map: evidenceMap,
  }

  // Persist
  dbSaveExpertCouncil(topicId, councilOutput)
  await writeArtifact(topicId, runId, "verdict_synthesis", finalVerdict)

  const rankedStr = finalVerdict.scenarios_ranked
    .map(s => `${(s.title ?? s.scenario_id).slice(0, 30)}=${Math.round(s.probability * 100)}%`)
    .join(", ")

  log.expert(`Scorer complete: ${rankedStr}`)
  emitThink(topicId, "✅", "Scenario scoring complete", rankedStr)

  emit(topicId, {
    type: "verdict_content",
    headline: finalVerdict.final_assessment.slice(0, 200),
    scenarios: finalVerdict.scenarios_ranked.map(s => ({ title: s.title ?? s.scenario_id, probability: s.probability })),
    final_assessment: finalVerdict.final_assessment,
    confidence_note: finalVerdict.confidence_note,
  })

  emit(topicId, { type: "stage_complete", stage: "expert_council" })
  onProgress?.("Scorer: complete")

  return councilOutput
}

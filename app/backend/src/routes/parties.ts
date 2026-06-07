import { Elysia, t } from "elysia"
import { getTopic } from "../pipeline/topicManager"
import { smartAddParty, smartEditParty, smartSplitParty, smartMergeParties } from "../agents/PartyIntelligence"
import { rescoreParty, computePentagonScore } from "../agents/PartyScorer"
import { dbGetParties, dbGetParty, dbUpsertParty, dbDeleteParty, dbSetParties } from "../db/queries/parties"
import { dbGetClues, dbReplaceClues } from "../db/queries/clues"
import { dbGetState } from "../db/queries/states"
import type { Party } from "../db/queries/parties"

export const partiesRouter = new Elysia({ prefix: "/api/topics/:id/parties" })
  .get("/", async ({ params, query }) => {
    const version = query.version ? parseInt(query.version as string) : null
    if (version) {
      const state = dbGetState(params.id, version)
      if (!state) return []

      // Only show parties if discovery has completed for this version
      if (!state.completed_stages.includes("discovery")) return []

      // Use snapshot for completed historical versions
      if (state.version_status === "complete" && state.parties_snapshot) {
        try { return JSON.parse(state.parties_snapshot) } catch { /* fall through */ }
      }
    }
    return dbGetParties(params.id)
  })

  .get("/:partyId", async ({ params, error }) => {
    const party = dbGetParty(params.id, params.partyId)
    return party ?? error(404, { message: "Party not found" })
  })

  // Manual add (bare fields)
  .post("/", async ({ params, body, error }) => {
    try {
      const b = body as Partial<Party>
      if (!b.name) return error(400, { message: "name is required" })
      const id = (b.id || b.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 30))
      let party: Party = {
        id, name: b.name, type: b.type ?? "non_state",
        description: b.description ?? "", weight: b.weight ?? 0,
        weight_factors: b.weight_factors ?? { military_capacity: 0, economic_control: 0, information_control: 0, international_support: 0, internal_legitimacy: 0 },
        agenda: b.agenda ?? "", means: b.means ?? [],
        circle: b.circle ?? { visible: [], shadow: [] },
        stance: b.stance ?? "passive", vulnerabilities: b.vulnerabilities ?? [],
        auto_discovered: false, user_verified: true,
      }
      const topic = await getTopic(params.id)
      party = await rescoreParty(params.id, topic.title, topic.description, party, topic.models.enrichment)
      dbUpsertParty(params.id, party)
      return party
    } catch (e) {
      return error(400, { message: String(e) })
    }
  }, { body: t.Record(t.String(), t.Any()) })

  .put("/:partyId", async ({ params, body, error }) => {
    try {
      const existing = dbGetParty(params.id, params.partyId)
      if (!existing) return error(404, { message: "Party not found" })
      const merged: Party = { ...existing, ...(body as Partial<Party>), id: existing.id }
      merged.weight = computePentagonScore(merged.weight_factors)
      dbUpsertParty(params.id, merged)
      return merged
    } catch (e) {
      return error(400, { message: String(e) })
    }
  }, { body: t.Record(t.String(), t.Any()) })

  .delete("/:partyId", async ({ params }) => {
    dbDeleteParty(params.id, params.partyId)
    return { success: true }
  })

  // Smart add: name only → LLM + web research → full party profile
  .post("/smart-add", async ({ params, body, error }) => {
    const b = body as { name: string }
    if (!b.name?.trim()) return error(400, { message: "name is required" })

    try {
      const topicId = params.id
      const topic = await getTopic(topicId)
      const existing = dbGetParties(topicId)

      const raw = await smartAddParty(
        topicId, topic.title, topic.description,
        b.name.trim(), topic.models.enrichment, existing,
      )
      const party = await rescoreParty(topicId, topic.title, topic.description, raw, topic.models.enrichment)

      dbUpsertParty(topicId, party)
      return party
    } catch (e) {
      return error(500, { message: `Smart add failed: ${e}` })
    }
  }, { body: t.Record(t.String(), t.Any()) })

  // Smart edit: user feedback → LLM + web research → updated party
  .post("/:partyId/smart-edit", async ({ params, body, error }) => {
    const b = body as { feedback: string }
    if (!b.feedback?.trim()) return error(400, { message: "feedback is required" })

    try {
      const topicId = params.id
      const topic = await getTopic(topicId)
      const current = dbGetParty(topicId, params.partyId)
      if (!current) return error(404, { message: "Party not found" })

      const edited = await smartEditParty(
        topicId, topic.title, current,
        b.feedback.trim(), topic.models.enrichment,
      )

      const merged: Party = { ...edited as Party, id: current.id }
      const final = await rescoreParty(topicId, topic.title, topic.description, merged, topic.models.enrichment)
      dbUpsertParty(topicId, final)
      return final
    } catch (e) {
      return error(500, { message: `Smart edit failed: ${e}` })
    }
  }, { body: t.Record(t.String(), t.Any()) })

  // Split: one party → multiple sub-parties via LLM
  .post("/split", async ({ params, body, error }) => {
    const b = body as { source_id: string; into: { name: string }[] }
    if (!b.source_id) return error(400, { message: "source_id is required" })
    if (!b.into?.length || b.into.length < 2) return error(400, { message: "Need at least 2 target names" })

    try {
      const topicId = params.id
      const topic = await getTopic(topicId)
      const source = dbGetParty(topicId, b.source_id)
      if (!source) return error(404, { message: "Source party not found" })

      const splitNames = b.into.map(i => i.name)
      const splitParties = await smartSplitParty(
        topicId, topic.title, source, splitNames, topic.models.enrichment,
      )
      const newParties = await Promise.all(
        splitParties.map(p => rescoreParty(topicId, topic.title, topic.description, p, topic.models.enrichment))
      )

      // Remove source, add new parties
      dbDeleteParty(topicId, b.source_id)
      for (const p of newParties) dbUpsertParty(topicId, p)

      // Update clue party_relevance references
      const primaryId = newParties[0]?.id
      if (primaryId) {
        const allClues = dbGetClues(topicId)
        const updated = allClues.map(clue => ({
          ...clue,
          versions: clue.versions.map(v => ({
            ...v,
            party_relevance: v.party_relevance.map(pr => pr === b.source_id ? primaryId : pr),
          })),
        }))
        dbReplaceClues(topicId, updated)
      }

      return { removed: b.source_id, created: newParties }
    } catch (e) {
      return error(500, { message: `Split failed: ${e}` })
    }
  }, { body: t.Record(t.String(), t.Any()) })

  // Smart merge: LLM synthesizes merged profile
  .post("/merge", async ({ params, body, error }) => {
    const b = body as { source_ids: string[]; target: Partial<Party> }
    if (!b.source_ids?.length || b.source_ids.length < 2) {
      return error(400, { message: "Need at least 2 source_ids to merge" })
    }
    if (!b.target?.name) return error(400, { message: "target.name is required" })

    try {
      const topicId = params.id
      const sources = b.source_ids.map(id => dbGetParty(topicId, id)).filter(Boolean) as Party[]
      if (sources.length < 2) return error(400, { message: "Not enough matching source parties" })

      const topic = await getTopic(topicId)

      let merged: Party
      try {
        const smartMerged = await smartMergeParties(
          topic.title, sources, b.target.name!, topic.models.enrichment,
        )
        merged = smartMerged as Party
      } catch {
        // Fallback: manual merge
        const targetId = b.target.name!.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 30)
        merged = {
          id: targetId,
          name: b.target.name!,
          type: b.target.type ?? sources[0].type,
          description: sources.map(s => s.description).join(" "),
          weight: Math.round(sources.reduce((s, p) => s + p.weight, 0) / sources.length),
          weight_factors: sources[0].weight_factors,
          agenda: sources.map(s => s.agenda).filter(Boolean).join("; "),
          means: [...new Set(sources.flatMap(s => s.means))],
          circle: {
            visible: [...new Set(sources.flatMap(s => s.circle?.visible ?? []))],
            shadow: [...new Set(sources.flatMap(s => s.circle?.shadow ?? []))],
          },
          stance: sources[0].stance,
          vulnerabilities: [...new Set(sources.flatMap(s => s.vulnerabilities))],
          auto_discovered: false,
          user_verified: true,
        }
      }

      const targetId = merged.id || b.target.name!.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 30)
      merged.id = targetId

      const scored = await rescoreParty(topicId, topic.title, topic.description, merged, topic.models.enrichment)
      scored.id = targetId

      for (const id of b.source_ids) dbDeleteParty(topicId, id)
      dbUpsertParty(topicId, scored)

      // Update clue party_relevance references
      const allClues = dbGetClues(topicId)
      const updated = allClues.map(clue => ({
        ...clue,
        versions: clue.versions.map(v => ({
          ...v,
          party_relevance: [...new Set(v.party_relevance.map(pr => b.source_ids.includes(pr) ? targetId : pr))],
        })),
      }))
      dbReplaceClues(topicId, updated)

      return scored
    } catch (e) {
      return error(500, { message: `Merge failed: ${e}` })
    }
  }, { body: t.Record(t.String(), t.Any()) })

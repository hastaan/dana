import { Elysia, t } from "elysia"
import { markStale } from "../pipeline/stateManager"
import { dbGetClues, dbGetClue, dbGetCluesAtSnapshot, dbInsertClue, dbUpdateClueVersion, dbDeleteClue,
         dbReplaceClues, dbNextClueId, dbCountClues } from "../db/queries/clues"
import { dbGetState } from "../db/queries/states"
import type { Clue, ClueVersion } from "../db/queries/clues"

const cleanupJobs = new Map<string, { status: string; groups: any[] | null; original_count: number; error?: string }>()
const bulkImportJobs = new Map<string, { status: string; stored: number; updated: number; skipped: number; error?: string }>()
const updateJobs = new Map<string, { status: string; checked: number; updated: number; error?: string }>()

export const cluesRouter = new Elysia({ prefix: "/api/topics/:id/clues" })
  .get("/", async ({ params, query }) => {
    const version = query.version ? parseInt(query.version as string) : null
    if (version) {
      const state = dbGetState(params.id, version)
      if (!state) return []

      // Only show clues if enrichment has completed for this version
      if (!state.completed_stages.includes("enrichment")) return []

      // Use snapshot for completed historical versions
      if (state.version_status === "complete" && state.clue_snapshot?.ids_and_versions) {
        return dbGetCluesAtSnapshot(params.id, state.clue_snapshot)
      }
    }
    return dbGetClues(params.id)
  })

  .get("/:clueId", async ({ params, error }) => {
    const clue = dbGetClue(params.id, params.clueId)
    return clue ?? error(404, { message: "Clue not found" })
  })

  .post("/", async ({ params, body, error }) => {
    try {
      const topicId = params.id
      const b = body as Record<string, any>
      const id = dbNextClueId(topicId)
      const now = new Date().toISOString()
      const timelineDate = b.timeline_date ?? now.slice(0, 10)

      const sourceUrls = b.source_urls ?? (b.source_url ? [b.source_url] : [])
      const sourceOutlets = b.source_outlets ?? []

      const version: ClueVersion = {
        v: 1, date: now,
        title: b.title,
        raw_source: { urls: sourceUrls, outlets: sourceOutlets, fetched_at: now },
        source_credibility: {
          score: b.credibility_score ?? 50,
          notes: b.credibility_notes ?? "",
          bias_flags: b.bias_flags ?? [],
          origin_sources: sourceUrls.map((url: string, i: number) => ({
            url, outlet: sourceOutlets[i] ?? "", is_republication: false,
          })),
        },
        bias_corrected_summary: b.bias_corrected_summary ?? "",
        relevance_score: b.relevance_score ?? 50,
        party_relevance: b.party_relevance ?? [],
        domain_tags: b.domain_tags ?? [],
        timeline_date: timelineDate,
        clue_type: b.clue_type ?? "event",
        change_note: "User-submitted initial version",
        key_points: b.key_points ?? [],
      }

      dbInsertClue(topicId, {
        id, current: 1, added_at: now, last_updated_at: now,
        added_by: "user", status: "verified", version,
      })

      await markStale(topicId)
      return dbGetClue(topicId, id)
    } catch (e) {
      return error(400, { message: String(e) })
    }
  }, { body: t.Record(t.String(), t.Any()) })

  .put("/:clueId", async ({ params, body, error }) => {
    const b = body as Record<string, unknown>
    const clue = dbGetClue(params.id, params.clueId)
    if (!clue) return error(404, { message: "Clue not found" })

    const cur = clue.versions.find(v => v.v === clue.current)!
    const patch: Partial<ClueVersion> = {}

    if (b.title !== undefined) patch.title = b.title as string
    if (b.bias_corrected_summary !== undefined) patch.bias_corrected_summary = b.bias_corrected_summary as string
    if (b.relevance_score !== undefined) patch.relevance_score = b.relevance_score as number
    if (b.party_relevance !== undefined) patch.party_relevance = b.party_relevance as string[]
    if (b.domain_tags !== undefined) patch.domain_tags = b.domain_tags as string[]
    if (b.timeline_date !== undefined) patch.timeline_date = b.timeline_date as string
    if (b.clue_type !== undefined) patch.clue_type = b.clue_type as string
    if (b.credibility_score !== undefined || b.bias_flags !== undefined || b.credibility_notes !== undefined) {
      patch.source_credibility = {
        ...cur.source_credibility,
        ...(b.credibility_score !== undefined ? { score: b.credibility_score as number } : {}),
        ...(b.bias_flags !== undefined ? { bias_flags: b.bias_flags as string[] } : {}),
        ...(b.credibility_notes !== undefined ? { notes: b.credibility_notes as string } : {}),
      }
    }

    dbUpdateClueVersion(params.id, params.clueId, patch)
    return dbGetClue(params.id, params.clueId)
  }, { body: t.Record(t.String(), t.Any()) })

  .delete("/:clueId", async ({ params }) => {
    dbDeleteClue(params.id, params.clueId)
    await markStale(params.id)
    return { success: true }
  })

  // Smart edit: user feedback → LLM + research → updated clue
  .post("/smart-edit/:clueId", async ({ params, body, set }) => {
    const b = body as { feedback: string }
    if (!b.feedback?.trim()) {
      set.status = 400
      return { message: "feedback is required" }
    }

    const { getTopic } = await import("../pipeline/topicManager")
    const { smartEditClue } = await import("../agents/SmartClueExtractor")

    const topicId = params.id
    const topic = await getTopic(topicId)
    const clue = dbGetClue(topicId, params.clueId)
    if (!clue) {
      set.status = 404
      return { message: "Clue not found" }
    }

    const cur = clue.versions.find(v => v.v === clue.current)!
    const currentData = {
      title: cur.title,
      summary: cur.bias_corrected_summary,
      credibility: cur.source_credibility.score,
      bias_flags: cur.source_credibility.bias_flags,
      relevance: cur.relevance_score,
      parties: cur.party_relevance,
      source_url: cur.raw_source?.urls?.[0] ?? cur.raw_source?.url ?? "",
      source_outlet: cur.source_credibility.origin_sources?.[0]?.outlet ?? cur.source_credibility.origin_source?.outlet ?? "",
      date: cur.timeline_date,
      clue_type: cur.clue_type,
    }

    try {
      const updated = await smartEditClue(topicId, topic.title, currentData, b.feedback.trim(), topic.models.enrichment)

      dbUpdateClueVersion(topicId, params.clueId, {
        title: updated.title,
        bias_corrected_summary: updated.summary,
        relevance_score: updated.relevance,
        party_relevance: updated.parties,
        timeline_date: updated.date,
        clue_type: updated.clue_type,
        domain_tags: updated.domain_tags ?? cur.domain_tags,
        source_credibility: {
          ...cur.source_credibility,
          score: updated.credibility,
          bias_flags: updated.bias_flags,
        },
      })

      return dbGetClue(topicId, params.clueId)
    } catch (e) {
      set.status = 500
      return { message: `Smart edit failed: ${e}` }
    }
  }, { body: t.Record(t.String(), t.Any()) })

  // Agentic bulk import: fire-and-forget + poll
  .post("/bulk", async ({ params, body, error }) => {
    const b = body as { content: string }
    if (!b.content?.trim()) return error(400, { message: "content is required" })
    const topicId = params.id

    const job = bulkImportJobs.get(topicId)
    if (!job || job.status === "done" || job.status === "error") {
      bulkImportJobs.set(topicId, { status: "running", stored: 0, updated: 0, skipped: 0 })

      ;(async () => {
        try {
          const { getTopic } = await import("../pipeline/topicManager")
          const { runBulkImportAgent } = await import("../agents/BulkImportAgent")
          const { dbGetParties } = await import("../db/queries/parties")
          const topic = await getTopic(topicId)
          const parties = dbGetParties(topicId)

          const result = await runBulkImportAgent(
            topicId, topic.title, topic.description,
            b.content, parties, topic.models.enrichment,
          )

          if (result.stored > 0 || result.updated > 0) await markStale(topicId)
          bulkImportJobs.set(topicId, { status: "done", ...result })
        } catch (e) {
          bulkImportJobs.set(topicId, { status: "error", stored: 0, updated: 0, skipped: 0, error: String(e) })
        }
      })()
    }

    return { status: bulkImportJobs.get(topicId)!.status }
  }, { body: t.Record(t.String(), t.Any()) })

  .get("/bulk/status", async ({ params }) => {
    const job = bulkImportJobs.get(params.id)
    if (!job) return { status: "none" }
    return job
  })

  // Evidence update: check all clues for updates
  .post("/update-all", async ({ params }) => {
    const topicId = params.id
    const job = updateJobs.get(topicId)
    if (!job || job.status === "done" || job.status === "error") {
      updateJobs.set(topicId, { status: "running", checked: 0, updated: 0 })

      ;(async () => {
        try {
          const { getTopic } = await import("../pipeline/topicManager")
          const { runEvidenceUpdateAgent } = await import("../agents/EvidenceUpdateAgent")
          const { dbGetParties } = await import("../db/queries/parties")
          const topic = await getTopic(topicId)
          const clues = dbGetClues(topicId)
          const parties = dbGetParties(topicId)

          const result = await runEvidenceUpdateAgent(
            topicId, topic.title, topic.description,
            clues, parties, topic.models.enrichment,
          )

          if (result.updated > 0) await markStale(topicId)
          updateJobs.set(topicId, { status: "done", ...result })
        } catch (e) {
          updateJobs.set(topicId, { status: "error", checked: 0, updated: 0, error: String(e) })
        }
      })()
    }

    return { status: updateJobs.get(topicId)!.status }
  })

  .get("/update-all/status", async ({ params }) => {
    const job = updateJobs.get(params.id)
    if (!job) return { status: "none" }
    return job
  })

  // Research: user gives a direction → system searches, fetches, extracts clues
  .post("/research", async ({ params, body, error }) => {
    const { getTopic } = await import("../pipeline/topicManager")
    const { researchAndExtractClues } = await import("../agents/SmartClueExtractor")
    const { dbGetParties } = await import("../db/queries/parties")

    const b = body as { query: string }
    if (!b.query?.trim()) return error(400, { message: "query is required" })

    const topicId = params.id
    const topic = await getTopic(topicId)
    const parties = dbGetParties(topicId)

    const extracted = await researchAndExtractClues(
      topicId, topic.title, topic.description,
      b.query.trim(), parties, topic.models.enrichment,
    )

    const created: Clue[] = []
    for (const item of extracted) {
      const now = new Date().toISOString()
      const id = dbNextClueId(topicId)
      const urls = item.source_urls ?? (item.source_url ? [item.source_url] : [])
      const outlets = item.source_outlets ?? (item.source_outlet ? [item.source_outlet] : ["research"])
      const version: ClueVersion = {
        v: 1, date: now, title: item.title,
        raw_source: { urls, outlets, fetched_at: now },
        source_credibility: {
          score: item.credibility ?? 50,
          notes: `Research: ${b.query.slice(0, 60)}`,
          bias_flags: item.bias_flags ?? [],
          origin_sources: urls.map((url: string, i: number) => ({
            url, outlet: outlets[i] ?? "research", is_republication: false,
          })),
        },
        bias_corrected_summary: item.summary,
        relevance_score: item.relevance ?? 70,
        party_relevance: item.parties ?? [],
        domain_tags: item.domain_tags ?? [],
        timeline_date: item.date || now.slice(0, 10),
        clue_type: item.clue_type || "event",
        change_note: `Research query: ${b.query.slice(0, 80)}`,
        key_points: item.key_points ?? [],
      }
      dbInsertClue(topicId, {
        id, current: 1, added_at: now, last_updated_at: now,
        added_by: "research" as any, status: "verified", version,
      })
      const newClue = dbGetClue(topicId, id)
      if (newClue) created.push(newClue)
    }

    if (created.length > 0) await markStale(topicId)
    return { imported: created.length, clues: created, query: b.query }
  }, { body: t.Record(t.String(), t.Any()) })

  // Cleanup: propose consolidation groups via CleanupAgent (fire-and-forget + poll)
  .post("/cleanup/propose", async ({ params }) => {
    const topicId = params.id

    if (!cleanupJobs.has(topicId) || cleanupJobs.get(topicId)!.status === "done" || cleanupJobs.get(topicId)!.status === "error") {
      cleanupJobs.set(topicId, { status: "running", groups: null, original_count: 0 })

      ;(async () => {
        try {
          const { getTopic } = await import("../pipeline/topicManager")
          const { runCleanupPropose } = await import("../agents/CleanupAgent")
          const { dbGetParties } = await import("../db/queries/parties")
          const topic = await getTopic(topicId)
          const clues = dbGetClues(topicId)
          const parties = dbGetParties(topicId)

          const clueData = clues.map(c => {
            const cur = c.versions.find(v => v.v === c.current)!
            return {
              id: c.id, title: cur.title, summary: cur.bias_corrected_summary,
              date: cur.timeline_date, credibility: cur.source_credibility.score,
              relevance: cur.relevance_score, parties: cur.party_relevance,
              clue_type: cur.clue_type, bias_flags: cur.source_credibility.bias_flags,
              domain_tags: cur.domain_tags,
            }
          })

          const groups = await runCleanupPropose(topicId, topic.title, clueData, parties, topic.models.enrichment)
          cleanupJobs.set(topicId, { status: "done", groups, original_count: clues.length })
        } catch (e) {
          cleanupJobs.set(topicId, { status: "error", groups: null, original_count: 0, error: String(e) })
        }
      })()
    }

    return { status: cleanupJobs.get(topicId)!.status }
  })

  .get("/cleanup/status", async ({ params }) => {
    const job = cleanupJobs.get(params.id)
    if (!job) return { status: "none" }
    if (job.status === "done") {
      return { status: "done", groups: job.groups, original_count: job.original_count }
    }
    return { status: job.status, error: (job as any).error }
  })

  // Cleanup: apply approved groups (merge/delete)
  .post("/cleanup/apply", async ({ params, body, set }) => {
    const b = body as { groups: any[] }
    if (!b.groups?.length) { set.status = 400; return { message: "No groups provided" } }

    const topicId = params.id
    const groups = b.groups
    const now = new Date().toISOString()

    const allClues = dbGetClues(topicId)
    const clueMap = new Map(allClues.map(c => [c.id, c]))

    function getCur(c: Clue): ClueVersion {
      return c.versions.find(v => v.v === c.current) ?? c.versions[c.versions.length - 1]!
    }

    const idsToDelete = new Set<string>()
    const newClues: { version: ClueVersion }[] = []

    for (const g of groups) {
      if (g.action === "keep") continue
      if (g.action === "delete") {
        for (const id of g.source_clue_ids) idsToDelete.add(id)
        continue
      }
      if (g.action === "merge") {
        for (const id of g.source_clue_ids) idsToDelete.add(id)

        // Collect source data from all merged clues
        const sourceClues = (g.source_clue_ids as string[]).map(id => clueMap.get(id)).filter(Boolean) as Clue[]
        // Sort by descending relevance so best key points come first
        sourceClues.sort((a, b) => (getCur(b).relevance_score ?? 0) - (getCur(a).relevance_score ?? 0))

        const seenUrls = new Set<string>()
        const mergedUrls: string[] = []
        const mergedOutlets: string[] = []
        const mergedOriginSources: ClueVersion["source_credibility"]["origin_sources"] = []

        for (const sc of sourceClues) {
          const cur = getCur(sc)
          const urls = cur.raw_source.urls ?? []
          const outlets = cur.raw_source.outlets ?? []
          urls.forEach((url, i) => {
            if (url && !seenUrls.has(url)) {
              seenUrls.add(url)
              mergedUrls.push(url)
              mergedOutlets.push(outlets[i] ?? "")
            }
          })
          for (const os of cur.source_credibility.origin_sources ?? []) {
            if (os.url && !seenUrls.has(`os:${os.url}`)) {
              seenUrls.add(`os:${os.url}`)
              mergedOriginSources.push(os)
            }
          }
        }

        const seenKp = new Set<string>()
        const mergedKeyPoints: string[] = []
        for (const sc of sourceClues) {
          for (const kp of getCur(sc).key_points ?? []) {
            const norm = kp.trim().toLowerCase()
            if (norm && !seenKp.has(norm)) { seenKp.add(norm); mergedKeyPoints.push(kp.trim()) }
          }
        }

        newClues.push({
          version: {
            v: 1, date: now, title: g.merged_title,
            raw_source: { urls: mergedUrls, outlets: mergedOutlets, fetched_at: now },
            source_credibility: {
              score: g.merged_credibility ?? 60,
              notes: `Merged from ${sourceClues.length} clues: ${sourceClues.map(c => c.id).join(", ")}`,
              bias_flags: g.merged_bias_flags ?? [],
              origin_sources: mergedOriginSources.length > 0
                ? mergedOriginSources
                : [{ url: "", outlet: "consolidated", is_republication: false }],
            },
            bias_corrected_summary: g.merged_summary,
            relevance_score: g.merged_relevance ?? 70,
            party_relevance: g.merged_parties ?? [],
            domain_tags: g.merged_domain_tags ?? [],
            timeline_date: g.merged_date || now.slice(0, 10),
            clue_type: g.merged_clue_type || "event",
            change_note: `Cleanup merge: ${g.reason}`,
            key_points: mergedKeyPoints.slice(0, 10),
          },
        })
      }
    }

    // Filter out deleted/merged, renumber, append merged clues
    const filtered = allClues.filter(c => !idsToDelete.has(c.id))
    const renumbered: Clue[] = filtered.map((c, i) => ({
      ...c,
      id: `clue-${String(i + 1).padStart(3, "0")}`,
    }))
    const mergedClues: Clue[] = newClues.map((nc, i) => ({
      id: `clue-${String(renumbered.length + i + 1).padStart(3, "0")}`,
      current: 1,
      added_at: now,
      last_updated_at: now,
      added_by: "cleanup" as any,
      status: "pending" as const,
      versions: [nc.version],
    }))

    dbReplaceClues(topicId, [...renumbered, ...mergedClues])
    await markStale(topicId)

    // Fire background fact-check sweep for all pending clues (merged + pre-existing)
    ;(async () => {
      try {
        const { getTopic } = await import("../pipeline/topicManager")
        const { runFactCheck } = await import("../agents/FactCheckAgent")
        const { dbGetControls } = await import("../db/queries/settings")
        const { emitThink, emit } = await import("../routes/stream")

        const topic = await getTopic(topicId)
        const controls = dbGetControls()
        const model = topic.models.enrichment

        const allAfter = dbGetClues(topicId)
        const pendingClues = allAfter.filter(c => {
          const cur = c.versions.find(v => v.v === c.current) ?? c.versions[c.versions.length - 1]
          return c.status === "pending" || !cur?.fact_check?.verdict
        })

        emitThink(topicId, "🔬", `Fact-checking ${pendingClues.length} pending clue(s)…`, "")

        await Promise.all(pendingClues.map(async (clue) => {
          const cur = clue.versions.find(v => v.v === clue.current) ?? clue.versions[clue.versions.length - 1]!
          try {
            const verdict = await runFactCheck({
              topicId, clueId: clue.id,
              title: cur.title,
              summary: cur.bias_corrected_summary,
              sourceUrls: cur.raw_source.urls ?? [],
              sourceOutlets: cur.raw_source.outlets ?? [],
              keyPoints: cur.key_points ?? [],
              biasFlags: cur.source_credibility.bias_flags ?? [],
              credibility: cur.source_credibility.score,
              partyContext: (cur.party_relevance ?? []).join(", "),
              topicTitle: topic.title,
              topicDescription: topic.description,
              model,
              maxIterations: controls.cleanup_fact_check_iterations,
            })
            emitThink(topicId,
              verdict.verdict === "verified" ? "✅" : verdict.verdict === "disputed" ? "🔶" : "⚠️",
              `${verdict.verdict.toUpperCase()}: ${cur.title.slice(0, 50)}`,
              verdict.bias_analysis.slice(0, 100))
          } catch {
            // fact-check failed — leave status as pending, don't crash the sweep
          }
        }))

        emit(topicId, { type: "stage_complete", stage: "cleanup" })
      } catch (e) {
        const { emit } = await import("../routes/stream")
        emit(topicId, { type: "stage_complete", stage: "cleanup" })
      }
    })()

    const finalClues = dbGetClues(topicId)
    return {
      original_count: groups.reduce((sum: number, g: any) => sum + (g.source_clue_ids?.length || 0), 0),
      merged: newClues.length,
      deleted: idsToDelete.size - newClues.length,
      final_count: finalClues.length,
    }
  }, { body: t.Record(t.String(), t.Any()) })

import { Elysia } from "elysia"
import { getTopic } from "../pipeline/topicManager"
import { runInitialPipeline } from "../pipeline/initialPipeline"
import { runDeltaPipeline } from "../pipeline/deltaPipeline"
import { runDiscoverStage, runEnrichStage, runAnalyzeStages, runReanalysis, runForumPrepStage, runForumStage, runScoringStage } from "../pipeline/gatedPipeline"

const activeRuns = new Map<string, { run_id: string; started_at: string }>()

export function getActiveRun(topicId: string) {
  return activeRuns.get(topicId) ?? null
}

function guardRunning(topicId: string) {
  if (activeRuns.has(topicId)) {
    return { running: true, run: activeRuns.get(topicId) }
  }
  return null
}

const STATUS_ORDER = [
  "draft", "discovery", "review_parties", "enrichment", "review_enrichment",
  "forum_prep", "review_forum_prep", "forum", "review_forum",
  "expert_council", "complete", "stale",
]

function statusAtLeast(current: string, minimum: string): boolean {
  const ci = STATUS_ORDER.indexOf(current)
  const mi = STATUS_ORDER.indexOf(minimum)
  if (ci === -1 || mi === -1) return false
  return ci >= mi
}

function trackRun(topicId: string, run_id: string) {
  const started_at = new Date().toISOString()
  activeRuns.set(topicId, { run_id, started_at })
  return { run_id, started_at }
}

export const pipelineRouter = new Elysia({ prefix: "/api/topics" })

  // Gated: Discovery only → review_parties
  .post("/:id/pipeline/discover", async ({ params, set }) => {
    const topicId = params.id
    try {
      await getTopic(topicId)
    } catch { set.status = 404; return { message: "Topic not found" } }

    const conflict = guardRunning(topicId)
    if (conflict) { set.status = 409; return { message: "Pipeline already running", ...conflict } }

    const { run_id, started_at } = trackRun(topicId, "discover")

    runDiscoverStage(topicId).then(() => {
      activeRuns.delete(topicId)
    }).catch(() => { activeRuns.delete(topicId) })

    return { run_id, started_at, status: "started" }
  })

  // Gated: Enrichment only → review_enrichment
  .post("/:id/pipeline/enrich", async ({ params, set }) => {
    const topicId = params.id
    try {
      const topic = await getTopic(topicId)
      if (!statusAtLeast(topic.status, "review_parties")) {
        set.status = 400; return { message: `Cannot enrich from status "${topic.status}". Run Discovery first.` }
      }
    } catch { set.status = 404; return { message: "Topic not found" } }

    const conflict = guardRunning(topicId)
    if (conflict) { set.status = 409; return { message: "Pipeline already running", ...conflict } }

    const { run_id, started_at } = trackRun(topicId, "enrich")

    runEnrichStage(topicId).then(() => {
      activeRuns.delete(topicId)
    }).catch(() => { activeRuns.delete(topicId) })

    return { run_id, started_at, status: "started" }
  })

  // Gated: Weight → Forum → Expert → Verdict (autonomous)
  .post("/:id/pipeline/analyze", async ({ params, set }) => {
    const topicId = params.id
    try {
      const topic = await getTopic(topicId)
      if (!statusAtLeast(topic.status, "review_enrichment")) {
        set.status = 400; return { message: `Cannot analyze from status "${topic.status}". Run Enrichment first.` }
      }
    } catch { set.status = 404; return { message: "Topic not found" } }

    const conflict = guardRunning(topicId)
    if (conflict) { set.status = 409; return { message: "Pipeline already running", ...conflict } }

    const { run_id, started_at } = trackRun(topicId, "analyze")

    runAnalyzeStages(topicId).then(() => {
      activeRuns.delete(topicId)
    }).catch(() => { activeRuns.delete(topicId) })

    return { run_id, started_at, status: "started" }
  })

  // Gated: Forum Prep only → review_forum_prep
  .post("/:id/pipeline/forum-prep", async ({ params, set }) => {
    const topicId = params.id
    try {
      const topic = await getTopic(topicId)
      if (!statusAtLeast(topic.status, "review_enrichment")) {
        set.status = 400; return { message: `Cannot run forum prep from status "${topic.status}". Run Enrichment first.` }
      }
    } catch { set.status = 404; return { message: "Topic not found" } }

    const conflict = guardRunning(topicId)
    if (conflict) { set.status = 409; return { message: "Pipeline already running", ...conflict } }

    const { run_id, started_at } = trackRun(topicId, "forum-prep")

    runForumPrepStage(topicId).then(() => {
      activeRuns.delete(topicId)
    }).catch(() => { activeRuns.delete(topicId) })

    return { run_id, started_at, status: "started" }
  })

  // Gated: Forum only → review_forum
  .post("/:id/pipeline/forum", async ({ params, set }) => {
    const topicId = params.id
    try {
      const topic = await getTopic(topicId)
      if (!statusAtLeast(topic.status, "review_forum_prep")) {
        set.status = 400; return { message: `Cannot run forum from status "${topic.status}". Run Forum Prep first.` }
      }
    } catch { set.status = 404; return { message: "Topic not found" } }

    const conflict = guardRunning(topicId)
    if (conflict) { set.status = 409; return { message: "Pipeline already running", ...conflict } }

    const { run_id, started_at } = trackRun(topicId, "forum")

    runForumStage(topicId).then(() => {
      activeRuns.delete(topicId)
    }).catch(() => { activeRuns.delete(topicId) })

    return { run_id, started_at, status: "started" }
  })

  // Gated: Scoring only → complete
  .post("/:id/pipeline/score", async ({ params, set }) => {
    const topicId = params.id
    try {
      const topic = await getTopic(topicId)
      if (!statusAtLeast(topic.status, "review_forum")) {
        set.status = 400; return { message: `Cannot run scoring from status "${topic.status}". Run Forum first.` }
      }
    } catch { set.status = 404; return { message: "Topic not found" } }

    const conflict = guardRunning(topicId)
    if (conflict) { set.status = 409; return { message: "Pipeline already running", ...conflict } }

    const { run_id, started_at } = trackRun(topicId, "score")

    runScoringStage(topicId).then(() => {
      activeRuns.delete(topicId)
    }).catch(() => { activeRuns.delete(topicId) })

    return { run_id, started_at, status: "started" }
  })

  // Clean re-analysis: fresh Weight → Forum → Expert → Verdict with current data
  .post("/:id/pipeline/reanalyze", async ({ params, set }) => {
    const topicId = params.id
    try {
      const topic = await getTopic(topicId)
      if (topic.status === "draft" || topic.status === "review_parties") {
        set.status = 400; return { message: `Cannot re-analyze from status "${topic.status}" — need at least enriched clues` }
      }
    } catch { set.status = 404; return { message: "Topic not found" } }

    const conflict = guardRunning(topicId)
    if (conflict) { set.status = 409; return { message: "Pipeline already running", ...conflict } }

    const { run_id, started_at } = trackRun(topicId, "reanalyze")

    runReanalysis(topicId).then(() => {
      activeRuns.delete(topicId)
    }).catch(() => { activeRuns.delete(topicId) })

    return { run_id, started_at, status: "started" }
  })

  // Full auto-run (skips gates — chains all stages)
  .post("/:id/pipeline/run", async ({ params, set }) => {
    const topicId = params.id
    try { await getTopic(topicId) }
    catch { set.status = 404; return { message: "Topic not found" } }

    const conflict = guardRunning(topicId)
    if (conflict) { set.status = 409; return { message: "Pipeline already running", ...conflict } }

    const { run_id, started_at } = trackRun(topicId, "initial-v1")

    runInitialPipeline(topicId).then(() => {
      activeRuns.delete(topicId)
    }).catch(() => { activeRuns.delete(topicId) })

    return { run_id, started_at, status: "started" }
  })

  // Delta update (stale topics)
  .post("/:id/pipeline/update", async ({ params, set }) => {
    const topicId = params.id
    try {
      const topic = await getTopic(topicId)
      if (topic.status !== "stale") {
        set.status = 400; return { message: "Topic is not stale" }
      }
    } catch { set.status = 404; return { message: "Topic not found" } }

    const conflict = guardRunning(topicId)
    if (conflict) { set.status = 409; return { message: "Pipeline already running", ...conflict } }

    const run_id = `delta-${Date.now().toString(36)}`
    const { started_at } = trackRun(topicId, run_id)

    runDeltaPipeline(topicId, run_id).then(() => {
      activeRuns.delete(topicId)
    }).catch(() => { activeRuns.delete(topicId) })

    return { run_id, started_at, status: "started" }
  })

  .get("/:id/pipeline/status", async ({ params }) => {
    const run = activeRuns.get(params.id)
    if (run) return { running: true, ...run }
    return { running: false }
  })

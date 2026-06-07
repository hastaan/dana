import { Elysia } from "elysia"
import { getForumSession } from "../tools/internal/getForumData"
import { dbGetRepresentatives } from "../db/queries/forum"
import { dbGetState, dbGetLatestState } from "../db/queries/states"
import { getDb } from "../db/database"

export const forumRouter = new Elysia({ prefix: "/api/topics/:id" })
  .get("/forum/:sessionId", async ({ params, error }) => {
    try {
      return await getForumSession(params.id, params.sessionId)
    } catch {
      return error(404, { message: "Forum session not found" })
    }
  })
  .get("/forum", async ({ params, query }) => {
    const version = query.version ? parseInt(query.version as string) : null

    // If version specified, look up forum_session_id from the states table
    if (version) {
      const state = dbGetState(params.id, version)
      if (!state) return null

      // Only show forum data if the forum stage has completed for this version
      if (!state.completed_stages.includes("forum")) return null

      if (state.forum_session_id) {
        try {
          return await getForumSession(params.id, state.forum_session_id)
        } catch { return null }
      }
      return null
    }

    // Default: latest session
    const row = getDb().query<{ id: string }, [string]>(
      "SELECT id FROM forum_sessions WHERE topic_id = ? ORDER BY started_at DESC LIMIT 1"
    ).get(params.id)
    if (!row) return null
    try {
      return await getForumSession(params.id, row.id)
    } catch {
      return null
    }
  })
  .get("/representatives", async ({ params, query }) => {
    const version = query.version ? parseInt(query.version as string) : null

    if (version) {
      const state = dbGetState(params.id, version)
      if (!state) return []

      // Only show reps if forum_prep has completed for this version
      if (!state.completed_stages.includes("forum_prep")) return []

      // Use snapshot for completed historical versions
      if (state.version_status === "complete" && state.representatives_snapshot) {
        try { return JSON.parse(state.representatives_snapshot) } catch { /* fall through */ }
      }
    }

    return dbGetRepresentatives(params.id)
  })

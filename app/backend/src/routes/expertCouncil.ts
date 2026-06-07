import { Elysia } from "elysia"
import { dbGetExpertCouncil, dbGetLatestExpertCouncil } from "../db/queries/expert"

export const expertCouncilRouter = new Elysia({ prefix: "/api/topics/:id" })
  .get("/expert-council", async ({ params }) => {
    return dbGetLatestExpertCouncil(params.id)
  })
  .get("/expert-council/:version", async ({ params, error }) => {
    const v = parseInt(params.version)
    if (isNaN(v)) return error(400, { message: "Invalid version" })
    const data = dbGetExpertCouncil(params.id, v)
    if (!data) return error(404, { message: "Expert council not found for this version" })
    return data
  })
  .get("/verdict", async ({ params }) => {
    const council = dbGetLatestExpertCouncil(params.id)
    return council?.final_verdict ?? null
  })
  .get("/verdict/:version", async ({ params }) => {
    const v = parseInt(params.version)
    if (isNaN(v)) return null
    const council = dbGetExpertCouncil(params.id, v)
    return council?.final_verdict ?? null
  })

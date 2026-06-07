import { Elysia, t } from "elysia"
import { listTopics, getTopic, createTopic, updateTopic, deleteTopic } from "../pipeline/topicManager"
import { getAllVersions } from "../pipeline/stateManager"

export const topicsRouter = new Elysia({ prefix: "/api/topics" })
  .get("/", async () => {
    return listTopics()
  })
  .get("/:id", async ({ params, error }) => {
    try {
      return await getTopic(params.id)
    } catch {
      return error(404, { message: "Topic not found" })
    }
  })
  .post("/", async ({ body, error }) => {
    try {
      return await createTopic(body)
    } catch (e) {
      return error(400, { message: String(e) })
    }
  }, {
    body: t.Object({
      title: t.String({ minLength: 1 }),
      description: t.String(),
      models: t.Optional(t.Record(t.String(), t.String())),
      settings: t.Optional(t.Record(t.String(), t.Any())),
    })
  })
  .put("/:id", async ({ params, body, error }) => {
    try {
      return await updateTopic(params.id, body)
    } catch {
      return error(404, { message: "Topic not found" })
    }
  }, {
    body: t.Partial(t.Object({
      title: t.String(),
      description: t.String(),
      status: t.String(),
      models: t.Record(t.String(), t.String()),
      settings: t.Record(t.String(), t.Any()),
    }))
  })
  .get("/:id/steering", async ({ params, error }) => {
    try {
      const t = await getTopic(params.id)
      return { steering: (t.settings?.steering as Record<string, unknown>) ?? {} }
    } catch {
      return error(404, { message: "Topic not found" })
    }
  })
  .put("/:id/steering", async ({ params, body, error }) => {
    try {
      const t = await getTopic(params.id)
      const settings = { ...(t.settings ?? {}), steering: body.steering ?? {} }
      const updated = await updateTopic(params.id, { settings })
      return { steering: (updated.settings?.steering as Record<string, unknown>) ?? {} }
    } catch {
      return error(404, { message: "Topic not found" })
    }
  }, {
    body: t.Object({
      steering: t.Object({
        framing_note: t.Optional(t.String({ maxLength: 4000 })),
        research_guidance: t.Optional(t.String({ maxLength: 4000 })),
        evidence_guidance: t.Optional(t.String({ maxLength: 4000 })),
        debate_guidance: t.Optional(t.String({ maxLength: 4000 })),
      }),
    })
  })
  .get("/:id/states", async ({ params }) => getAllVersions(params.id))

  .delete("/:id", async ({ params, error }) => {
    try {
      await deleteTopic(params.id)
      return { success: true }
    } catch {
      return error(404, { message: "Topic not found" })
    }
  })

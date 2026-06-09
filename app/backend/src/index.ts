import { Elysia } from "elysia"
import { join } from "path"
import { existsSync } from "fs"
import { cors } from "@elysiajs/cors"
import { swagger } from "@elysiajs/swagger"
import { initDb } from "./db/database"
import { topicsRouter } from "./routes/topics"
import { streamRouter } from "./routes/stream"
import { cluesRouter } from "./routes/clues"
import { partiesRouter } from "./routes/parties"
import { forumRouter } from "./routes/forum"
import { pipelineRouter } from "./routes/pipeline"
import { expertCouncilRouter } from "./routes/expertCouncil"
import { settingsRouter } from "./routes/settings"
import { promptsRouter } from "./routes/prompts"
import { providersRouter } from "./routes/providers"
import { customProvidersRouter } from "./routes/customProviders"
import { calibrationRouter } from "./routes/calibration"
import { researchRouter } from "./routes/research"
import { authPlugin } from "./middleware/auth"
import { seedDefaults } from "./db/queries/promptConfigs"
import { seedDemoTopic } from "./db/seedDemo"
import { fetchAvailableModels } from "./llm/proxyClient"
import { startModelCatalog, getModelCatalog } from "./llm/modelCatalog"

const DIST_DIR = join(import.meta.dir, "../../frontend/dist")

const MIME_TYPES: Record<string, string> = {
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}

function getMimeType(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase()
  return MIME_TYPES[ext] || "application/octet-stream"
}

function serveStatic(filePath: string) {
  if (!existsSync(filePath)) {
    return new Response("Not found", { status: 404 })
  }
  return new Response(Bun.file(filePath), {
    headers: { "Content-Type": getMimeType(filePath) },
  })
}


initDb()
seedDefaults()
seedDemoTopic()
void startModelCatalog()

const app = new Elysia()
  .use(cors())
  .use(swagger({ path: "/docs" }))
  .use(authPlugin)
  .use(topicsRouter)
  .use(streamRouter)
  .use(cluesRouter)
  .use(partiesRouter)
  .use(forumRouter)
  .use(pipelineRouter)
  .use(expertCouncilRouter)
  .use(settingsRouter)
  .use(promptsRouter)
  .use(providersRouter)
  .use(customProvidersRouter)
  .use(calibrationRouter)
  .use(researchRouter)
  .get("/health", () => ({ status: "ok" }))
  .get("/api/health", () => ({ status: "ok" }))
  .get("/api/models", async () => {
    return fetchAvailableModels()
  })
  .get("/api/models/catalog", async () => {
    return getModelCatalog()
  })
  .get("/assets/*", ({ path }) => {
    const filePath = join(DIST_DIR, path.replace(/^\/assets\//, "assets/"))
    return serveStatic(filePath)
  })
  .get("/favicon.svg", () => serveStatic(join(DIST_DIR, "favicon.svg")))
  .get("/icons.svg", () => serveStatic(join(DIST_DIR, "icons.svg")))
  .get("/*", ({ path }) => {
    if (path.startsWith("/api/")) return new Response("Not found", { status: 404 })
    return serveStatic(join(DIST_DIR, "index.html"))
  })
  .listen(Number(process.env.PORT) || 3000)

console.log(`\x1b[1m\x1b[36mDana\x1b[0m backend running at \x1b[36mhttp://localhost:${app.server?.port}\x1b[0m`)
console.log(`  Data:  ${process.env.DATA_DIR || "/home/nima/dana/data"}`)
console.log(`  Proxy: ${process.env.PROXY_BASE_URL || "http://127.0.0.1:8317"}`)

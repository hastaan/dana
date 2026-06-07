import { join } from "path"
import { mkdir } from "fs/promises"

function getDataDir() { return process.env.DATA_DIR || "/home/nima/dana/data" }

function artifactPath(topicId: string, runId: string, name: string): string {
  return join(getDataDir(), "topics", topicId, "logs", `run-${runId}`, `${name}.json`)
}

export async function writeArtifact(topicId: string, runId: string, name: string, data: unknown): Promise<{ path: string; written_at: string }> {
  const dir = join(getDataDir(), "topics", topicId, "logs", `run-${runId}`)
  await mkdir(dir, { recursive: true })
  const path = artifactPath(topicId, runId, name)
  const written_at = new Date().toISOString()
  await Bun.write(path, JSON.stringify(data, null, 2))
  return { path, written_at }
}

export async function readArtifact<T>(topicId: string, runId: string, name: string): Promise<T> {
  const path = artifactPath(topicId, runId, name)
  const file = Bun.file(path)
  if (!(await file.exists())) throw new Error(`Artifact not found: ${path}`)
  return file.json() as Promise<T>
}

export async function artifactExists(topicId: string, runId: string, name: string): Promise<boolean> {
  return Bun.file(artifactPath(topicId, runId, name)).exists()
}

const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
}

const STAGE_COLORS: Record<string, string> = {
  DISCOVERY: COLORS.cyan,
  ENRICHMENT: COLORS.blue,
  WEIGHT: COLORS.magenta,
  FORUM: COLORS.yellow,
  EXPERT: COLORS.green,
  VERDICT: COLORS.red,
  DELTA: COLORS.magenta,
  SCORING: COLORS.green,
  PIPELINE: COLORS.bold,
  LLM: COLORS.gray,
  TOOL: COLORS.dim,
}

function ts(): string {
  return new Date().toISOString().slice(11, 23)
}

function fmt(stage: string, msg: string, detail?: string): string {
  const color = STAGE_COLORS[stage] || COLORS.reset
  const base = `${COLORS.gray}[${ts()}]${COLORS.reset} ${color}[${stage}]${COLORS.reset} ${msg}`
  if (detail) return `${base} ${COLORS.dim}${detail}${COLORS.reset}`
  return base
}

export const log = {
  pipeline(msg: string, detail?: string) { console.log(fmt("PIPELINE", msg, detail)) },
  discovery(msg: string, detail?: string) { console.log(fmt("DISCOVERY", msg, detail)) },
  enrichment(msg: string, detail?: string) { console.log(fmt("ENRICHMENT", msg, detail)) },
  weight(msg: string, detail?: string) { console.log(fmt("WEIGHT", msg, detail)) },
  forum(msg: string, detail?: string) { console.log(fmt("FORUM", msg, detail)) },
  expert(msg: string, detail?: string) { console.log(fmt("EXPERT", msg, detail)) },
  verdict(msg: string, detail?: string) { console.log(fmt("VERDICT", msg, detail)) },
  delta(msg: string, detail?: string) { console.log(fmt("DELTA", msg, detail)) },
  llm(msg: string, detail?: string) { console.log(fmt("LLM", msg, detail)) },
  tool(msg: string, detail?: string) { console.log(fmt("TOOL", msg, detail)) },
  scoring(msg: string, detail?: string) { console.log(fmt("SCORING", msg, detail)) },
  stage(name: string, msg: string, detail?: string) { console.log(fmt(name.toUpperCase(), msg, detail)) },
  error(stage: string, msg: string, err?: unknown) {
    console.error(`${COLORS.gray}[${ts()}]${COLORS.reset} ${COLORS.red}[${stage} ERROR]${COLORS.reset} ${msg}`, err ? String(err) : "")
  },
  separator() { console.log(`${COLORS.gray}${"─".repeat(70)}${COLORS.reset}`) },
}

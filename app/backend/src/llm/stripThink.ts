// `<think>` stripping (⇄ server-py llm/think.py).
//
// MiniMax (and other reasoning models) emit `<think>…</think>` blocks that break typed JSON
// parsing downstream. Strip them at the point assistant content enters the pipeline so the
// reasoning never poisons a JSON.parse. Handles a closed block and the case where the opening
// tag was dropped but a stray `</think>` remains (keep only what follows it).

const THINK_RE = /<think>.*?<\/think>\s*/gis
const ORPHAN_CLOSE_RE = /^.*?<\/think>\s*/is

export function stripThink(text: string): string {
  if (typeof text !== "string" || !text.toLowerCase().includes("think>")) return text
  let out = text.replace(THINK_RE, "")
  if (out.toLowerCase().includes("</think>")) {
    // orphan close with no open → keep the tail
    out = out.replace(ORPHAN_CLOSE_RE, "")
  }
  return out.replace(/^\s+/, "")
}

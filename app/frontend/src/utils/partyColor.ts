// Deterministic HSL color from party name — consistent across entire app
const PALETTE = [
  "#ef4444", // red
  "#3b82f6", // blue
  "#10b981", // emerald
  "#f59e0b", // amber
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#14b8a6", // teal
  "#f97316", // orange
  "#6366f1", // indigo
  "#84cc16", // lime
  "#0ea5e9", // sky
  "#d946ef", // fuchsia
  "#64748b", // slate
  "#78716c", // stone
]

export function partyColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
  return PALETTE[Math.abs(hash) % PALETTE.length]
}

// Returns hex color with alpha as CSS rgba
export function partyColorAlpha(name: string, alpha: number): string {
  const hex = partyColor(name)
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${alpha})`
}

export const STAGE_COLORS: Record<string, { bg: string; text: string; border: string; dot: string }> = {
  discovery:        { bg: "bg-blue-50",    text: "text-blue-700",   border: "border-blue-200",   dot: "bg-blue-500" },
  enrichment:       { bg: "bg-indigo-50",  text: "text-indigo-700", border: "border-indigo-200", dot: "bg-indigo-500" },
  weight:           { bg: "bg-slate-50",   text: "text-slate-700",  border: "border-slate-200",  dot: "bg-slate-500" },
  forum:            { bg: "bg-blue-50",    text: "text-blue-700",   border: "border-blue-200",   dot: "bg-blue-500" },
  expert_council:   { bg: "bg-purple-50",  text: "text-purple-700", border: "border-purple-200", dot: "bg-purple-500" },
  verdict:          { bg: "bg-amber-50",   text: "text-amber-700",  border: "border-amber-200",  dot: "bg-amber-500" },
}

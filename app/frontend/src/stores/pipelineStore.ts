import { create } from "zustand"
import type { SSEEvent } from "@/hooks/useSSE"

export type PipelineFeedItem =
  | { id: string; type: "think"; icon: string; label: string; detail?: string; ts: number }
  | { id: string; type: "progress"; stage: string; pct: number; msg: string; ts: number }
  | { id: string; type: "forum_turn"; turn: Record<string, unknown>; ts: number }
  | { id: string; type: "clue_discovered"; clue_id: string; title: string; source: string; relevance: number; ts: number }
  | { id: string; type: "stage_complete"; stage: string; ts: number }
  | { id: string; type: "error"; message: string; ts: number }
  | { id: string; type: "weight_result"; parties: { name: string; weight: number }[]; ts: number }
  | { id: string; type: "expert_assessment"; expert: string; domain: string; summary: string; ts: number }
  | { id: string; type: "verdict_content"; headline: string; scenarios?: { title: string; probability: number }[]; ts: number }

export interface ActiveOperation {
  topicId: string
  type: string
  label: string
  events: PipelineFeedItem[]
  seen: Set<number> // server `_seq`s already added — dedupes replay-on-connect vs live
}

interface TopicPipelineState {
  items: PipelineFeedItem[]
  seen: Set<number> // server `_seq`s already added to this topic's persistent feed
}

interface PipelineStore {
  sessions: Record<string, TopicPipelineState>
  activeOperation: ActiveOperation | null
  resetTopic: (topicId: string) => void
  pushEvent: (topicId: string, event: SSEEvent) => void
  startOperation: (topicId: string, type: string, label: string) => void
  finishOperation: () => void
}

function normalizeEvent(id: string, event: SSEEvent): PipelineFeedItem {
  const ts = Date.now()
  if (event.type === "ping") return { id, ts, type: "error", message: "ping" }
  if (event.type === "think") return { id, ts, ...event }
  if (event.type === "progress") return { id, ts, ...event }
  if (event.type === "forum_turn") return { id, ts, ...event }
  if (event.type === "clue_discovered") return { id, ts, ...event }
  if (event.type === "stage_complete") return { id, ts, ...event }
  if (event.type === "error") return { id, ts, ...event }
  if (event.type === "weight_result") return { id, ts, ...event }
  if (event.type === "expert_assessment") return { id, ts, ...event }
  return { id, ts, type: "verdict_content", headline: event.headline, scenarios: event.scenarios ?? [] }
}

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export const usePipelineStore = create<PipelineStore>((set) => ({
  sessions: {},
  activeOperation: null,

  resetTopic: (topicId) => set((state) => ({
    sessions: {
      ...state.sessions,
      [topicId]: { items: [], seen: new Set() },
    },
  })),

  startOperation: (topicId, type, label) => set(() => ({
    activeOperation: { topicId, type, label, events: [], seen: new Set() },
  })),

  finishOperation: () => set(() => ({
    activeOperation: null,
  })),

  pushEvent: (topicId, event) => {
    if (event.type === "ping") return
    set((state) => {
      const id = uid()
      const item = normalizeEvent(id, event)
      const seq = event._seq

      // Push to persistent session feed, deduping by server `_seq` (replay-on-connect overlaps
      // live events). When no _seq (shouldn't happen), fall through and append.
      const current = state.sessions[topicId] ?? { items: [], seen: new Set<number>() }
      let nextSession = current
      if (seq === undefined || !current.seen.has(seq)) {
        const seen = new Set(current.seen)
        if (seq !== undefined) seen.add(seq)
        nextSession = { items: [...current.items.slice(-99), item], seen }
      }

      // Also push to active operation if it matches — independent dedupe (its own SSE connection
      // replays the same window).
      const op = state.activeOperation
      let nextOp = op
      if (op && op.topicId === topicId && (seq === undefined || !op.seen.has(seq))) {
        const seen = new Set(op.seen)
        if (seq !== undefined) seen.add(seq)
        nextOp = { ...op, events: [...op.events, item], seen }
      }

      return {
        sessions: { ...state.sessions, [topicId]: nextSession },
        activeOperation: nextOp,
      }
    })
  },
}))

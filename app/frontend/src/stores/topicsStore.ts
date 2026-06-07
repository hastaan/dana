import { create } from "zustand"
import { api, type Topic } from "../api/client"

interface TopicsStore {
  topics: Topic[]
  loading: boolean
  error: string | null
  setTopics: (topics: Topic[]) => void
  fetch: () => Promise<void>
  create: (title: string, description: string) => Promise<Topic>
  delete: (id: string) => Promise<void>
  upsertTopic: (topic: Topic) => void
}

export const useTopicsStore = create<TopicsStore>((set) => ({
  topics: [],
  loading: false,
  error: null,
  setTopics: (topics) => set({ topics }),
  upsertTopic: (topic) => set(s => ({ topics: [topic, ...s.topics.filter(t => t.id !== topic.id)] })),

  fetch: async () => {
    set({ loading: true, error: null })
    try {
      const topics = await api.topics.list()
      set({ topics, loading: false })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e), loading: false })
    }
  },

  create: async (title, description) => {
    const topic = await api.topics.create({ title, description })
    set(s => ({ topics: [topic, ...s.topics.filter(t => t.id !== topic.id)] }))
    return topic
  },

  delete: async (id) => {
    await api.topics.delete(id)
    set(s => ({ topics: s.topics.filter(t => t.id !== id) }))
  },
}))

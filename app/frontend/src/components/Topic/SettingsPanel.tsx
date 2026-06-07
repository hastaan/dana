import { useEffect, useState } from "react"
import { api, type Topic } from "../../api/client"

const TASK_CATEGORIES = [
  { key: "data_gathering", label: "Data Gathering", desc: "Web search, HTTP fetch" },
  { key: "extraction", label: "Extraction", desc: "ClueProcessor" },
  { key: "enrichment", label: "Enrichment", desc: "Discovery, Enrichment, Forum Prep" },
  { key: "delta_updates", label: "Delta Updates", desc: "Delta reps, delta experts" },
  { key: "forum_reasoning", label: "Forum Reasoning", desc: "Representatives, Forum Moderation" },
  { key: "expert_council", label: "Scenario Scoring", desc: "Evidence-based scenario probability ranking" },
]

interface Props {
  topic: Topic
  onClose: () => void
  onSave: (updated: Topic) => void
}

export function SettingsPanel({ topic, onClose, onSave }: Props) {
  const [models, setModels] = useState<Record<string, string>>(topic.models || {})
  const [settings, setSettings] = useState<Record<string, unknown>>(topic.settings || {})
  const [availableModels, setAvailableModels] = useState<{ id: string }[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.models.list().then(setAvailableModels).catch(() => {})
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      const updated = await api.topics.update(topic.id, { models, settings })
      onSave(updated)
      onClose()
    } catch (e) {
      console.error("Failed to save settings:", e)
    } finally {
      setSaving(false)
    }
  }

  const handleReset = () => {
    setModels({
      data_gathering: "claude-haiku-4-5-20251001",
      extraction: "claude-haiku-4-5-20251001",
      enrichment: "claude-sonnet-4-6",
      delta_updates: "claude-sonnet-4-6",
      forum_reasoning: "claude-opus-4-6",
      expert_council: "claude-opus-4-6",
    })
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-lg max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-gray-900">Topic Settings</h2>
          <button className="text-gray-400 hover:text-gray-600 text-sm" onClick={onClose}>&#10005;</button>
        </div>

        {/* Model assignment */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-gray-700">Model Assignment</h3>
            <button
              className="text-[10px] text-gray-400 hover:text-gray-600"
              onClick={handleReset}
            >
              Reset to Defaults
            </button>
          </div>
          <div className="space-y-3">
            {TASK_CATEGORIES.map(cat => (
              <div key={cat.key} className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-gray-700">{cat.label}</div>
                  <div className="text-[10px] text-gray-400">{cat.desc}</div>
                </div>
                <select
                  className="text-xs border border-gray-200 rounded px-2 py-1 bg-white text-gray-700 w-44"
                  value={models[cat.key] || ""}
                  onChange={e => setModels({ ...models, [cat.key]: e.target.value })}
                >
                  <option value="">Select model</option>
                  {availableModels.map(m => (
                    <option key={m.id} value={m.id}>{m.id}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>

        {/* Topic settings */}
        <div className="mb-6">
          <h3 className="text-sm font-medium text-gray-700 mb-3">Analysis Settings</h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs text-gray-600">Forum rounds</label>
              <input
                type="number" min={1} max={5}
                className="w-16 text-xs border border-gray-200 rounded px-2 py-1 text-center"
                value={(settings.forum_rounds as number) ?? 3}
                onChange={e => setSettings({ ...settings, forum_rounds: parseInt(e.target.value) || 3 })}
              />
            </div>
            <div className="flex items-center justify-between">
              <label className="text-xs text-gray-600">Expert count</label>
              <input
                type="number" min={2} max={8}
                className="w-16 text-xs border border-gray-200 rounded px-2 py-1 text-center"
                value={(settings.expert_count as number) ?? 6}
                onChange={e => setSettings({ ...settings, expert_count: parseInt(e.target.value) || 6 })}
              />
            </div>
            <div className="flex items-center justify-between">
              <label className="text-xs text-gray-600">Search depth</label>
              <input
                type="number" min={1} max={10}
                className="w-16 text-xs border border-gray-200 rounded px-2 py-1 text-center"
                value={(settings.clue_search_depth as number) ?? 3}
                onChange={e => setSettings({ ...settings, clue_search_depth: parseInt(e.target.value) || 3 })}
              />
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2 justify-end">
          <button
            className="px-3 py-1.5 text-xs text-gray-600 hover:text-gray-800"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  )
}

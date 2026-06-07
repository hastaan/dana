import { create } from "zustand"

type ThemeMode = "light" | "dark" | "system"

interface UIStore {
  theme: ThemeMode
  setTheme: (theme: ThemeMode) => void
}

const THEME_KEY = "dana.theme"
const readTheme = () => (localStorage.getItem(THEME_KEY) as ThemeMode | null) ?? "dark"

export const useUIStore = create<UIStore>((set) => ({
  theme: "dark",
  setTheme: (theme) => {
    localStorage.setItem(THEME_KEY, theme)
    set({ theme })
  },
}))

if (typeof window !== "undefined") {
  useUIStore.setState({ theme: readTheme() })
}

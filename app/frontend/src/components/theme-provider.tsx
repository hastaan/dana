import { ThemeProvider as NextThemesProvider } from "next-themes"
import type { ThemeProviderProps } from "next-themes"
import { useUIStore } from "../stores/uiStore"

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  const { theme } = useUIStore()
  return <NextThemesProvider attribute="class" defaultTheme={theme} enableSystem={true} {...props}>{children}</NextThemesProvider>
}

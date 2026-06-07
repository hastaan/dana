import { StrictMode, Suspense, lazy } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter, Route, Routes } from "react-router-dom"
import { AppShell } from "./components/AppShell"
import { ErrorBoundary } from "./components/ErrorBoundary"
import { ThemeProvider } from "./components/theme-provider"
import { Dashboard } from "./pages/Dashboard"
import "./index.css"

const TopicView = lazy(() => import("./pages/TopicView").then(module => ({ default: module.TopicView })))
const SettingsPage = lazy(() => import("./pages/Settings").then(module => ({ default: module.SettingsPage })))

function LoadingFallback() {
  return <div className="flex min-h-[40vh] items-center justify-center text-sm text-muted-foreground">Loading…</div>
}

function NotFoundPage() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
      <div>
        <h1 className="text-2xl font-semibold">404</h1>
        <p className="mt-2 text-sm text-muted-foreground">Page not found.</p>
      </div>
      <a href="/" className="text-sm font-medium text-primary underline-offset-4 hover:underline">Go Home</a>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/" element={<Dashboard />} />
              <Route path="/topic/:id" element={<Suspense fallback={<LoadingFallback />}><TopicView /></Suspense>} />
              <Route path="/settings" element={<Suspense fallback={<LoadingFallback />}><SettingsPage /></Suspense>} />
              <Route path="/settings/:tab" element={<Suspense fallback={<LoadingFallback />}><SettingsPage /></Suspense>} />
            </Route>
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </BrowserRouter>
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>,
)

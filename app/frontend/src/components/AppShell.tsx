import { ChevronRight, Settings } from "lucide-react"
import { Link, NavLink, Outlet, useLocation, useParams } from "react-router-dom"
import { ThemeToggle } from "./theme-toggle"
import { useTopicsStore } from "../stores/topicsStore"
import { cn } from "@/lib/utils"

export function AppShell() {
  const { topics } = useTopicsStore()
  const location = useLocation()
  const params = useParams()
  const topic = topics.find(t => t.id === params.id)

  const crumbs = buildBreadcrumbs(location.pathname, topic?.title, params)

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b border-border/70 bg-card/80 px-6 backdrop-blur">
        <Link to="/" className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground text-sm font-semibold">D</div>
          <span className="text-sm font-semibold">Dana</span>
        </Link>

        <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
          {crumbs.map((crumb, i) => (
            <span key={crumb.path} className="flex items-center gap-1.5">
              <ChevronRight className="size-3.5" />
              {i === crumbs.length - 1 ? (
                <span className="font-medium text-foreground">{crumb.label}</span>
              ) : (
                <Link to={crumb.path} className="hover:text-foreground transition-colors">{crumb.label}</Link>
              )}
            </span>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <NavLink to="/settings" className={({ isActive }) => cn("inline-flex h-8 w-8 items-center justify-center rounded-md border border-border transition-colors hover:bg-accent", isActive && "bg-accent text-accent-foreground")}>
            <Settings className="size-4" />
          </NavLink>
          <ThemeToggle />
        </div>
      </header>
      <main className="min-w-0 flex-1 overflow-auto"><Outlet /></main>
    </div>
  )
}

function buildBreadcrumbs(pathname: string, topicTitle?: string, params?: Record<string, string | undefined>) {
  const crumbs: { label: string; path: string }[] = []

  if (pathname === "/") {
    crumbs.push({ label: "Dashboard", path: "/" })
  } else if (pathname.startsWith("/topic/") && params?.id) {
    crumbs.push({ label: "Dashboard", path: "/" })
    crumbs.push({ label: topicTitle || params.id, path: `/topic/${params.id}` })
  } else if (pathname.startsWith("/settings")) {
    crumbs.push({ label: "Dashboard", path: "/" })
    crumbs.push({ label: "Settings", path: "/settings" })
  }

  return crumbs
}

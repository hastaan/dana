import { Component, type ReactNode } from "react"

type Props = { children: ReactNode }
type State = { hasError: boolean; message: string }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: "" }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-background p-6 text-center text-foreground">
          <div className="max-w-md space-y-3 rounded-xl border border-border bg-card p-6 shadow-sm">
            <h1 className="text-lg font-semibold">Can’t load Dana right now</h1>
            <p className="text-sm text-muted-foreground">The app encountered a connection problem or unexpected error. Please check that the backend is running and try again.</p>
            <p className="text-xs text-muted-foreground">{this.state.message}</p>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

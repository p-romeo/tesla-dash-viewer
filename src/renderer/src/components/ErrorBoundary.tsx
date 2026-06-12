import { Component, type ErrorInfo, type ReactNode } from 'react'

// React 18 has no functional error-boundary API (no hook equivalent for
// componentDidCatch), so this is the one sanctioned class component in the repo
// — it's the only way to keep an unhandled render throw from white-screening the
// whole app. Everything else stays functional + hooks per CLAUDE.md/AGENTS.md.
export default class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Forwarded to the main-process console as [renderer] in dev (see main/index.ts).
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="flex h-screen items-center justify-center bg-ink-950 p-6">
        <div className="flex max-w-md flex-col items-center gap-4 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-red-500/15 text-3xl text-red-400">
            ⚠
          </div>
          <div>
            <h2 className="text-lg font-semibold text-slate-200">Something went wrong</h2>
            <p className="mt-1 text-sm text-slate-500">
              The viewer hit an unexpected error and stopped rendering.
            </p>
            <p className="mt-2 break-words font-mono text-xs text-red-400">{error.message}</p>
          </div>
          <button
            onClick={() => location.reload()}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-accent-soft"
          >
            Reload
          </button>
        </div>
      </div>
    )
  }
}

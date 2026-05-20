import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('App crashed:', error, info.componentStack)
  }

  reset = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    const message = this.state.error.message || String(this.state.error)
    return (
      <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="display-font text-2xl font-bold text-[var(--ink)]">Something went wrong</h1>
        <p className="max-w-md text-sm text-[var(--muted)]">
          The app hit an error and couldn't render. Reloading usually fixes it.
        </p>
        <pre className="max-w-md overflow-x-auto rounded-xl border border-[var(--line)] bg-[var(--accent-soft)] p-3 text-left text-[10px] text-[var(--ink)]">
          {message}
        </pre>
        <div className="flex gap-2">
          <button
            onClick={() => location.reload()}
            className="rounded-2xl bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-white"
          >
            Reload
          </button>
          <button
            onClick={this.reset}
            className="rounded-2xl border border-[var(--line)] px-5 py-2 text-sm font-semibold text-[var(--ink)]"
          >
            Try again
          </button>
        </div>
      </div>
    )
  }
}

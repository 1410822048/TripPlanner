// src/components/ErrorBoundary.tsx
// Catches render-time and lifecycle throws (schema validation, unexpected
// nulls) so a single bad Firestore doc doesn't white-screen the whole app.
// Placed above <RouterProvider /> for the root boundary; also used by each
// standalone route via the `fallback` prop so a crash inside e.g.
// SocialCirclePage shows a recoverable screen instead of a white app.
import { Component, type ReactNode, type ErrorInfo } from 'react'

type Fallback =
  | ReactNode
  | ((error: Error, reset: () => void) => ReactNode)

interface Props  {
  children: ReactNode
  /**
   * Optional custom UI shown when a descendant throws. Either a ReactNode
   * (static) or a function that receives the error + a reset callback
   * (so a caller can offer "retry", "go home", etc.). Omitted → falls
   * back to the full-screen default.
   */
  fallback?: Fallback
}
interface State  { error: Error | null }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State { return { error } }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep stack visible in dev; a real deploy would forward to Sentry etc.
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  reset = () => this.setState({ error: null })

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    const { fallback } = this.props
    if (typeof fallback === 'function') return fallback(error, this.reset)
    if (fallback !== undefined)         return fallback

    return (
      <div className="min-h-dvh bg-app flex items-center justify-center px-6">
        <div className="max-w-sm w-full text-center">
          <div className="text-[44px] mb-2">😿</div>
          <h1 className="m-0 mb-2 text-[18px] font-black text-ink">
            問題が発生しました
          </h1>
          <p className="m-0 mb-4 text-[12.5px] text-muted tracking-[0.02em] break-words">
            {error.message || '不明なエラー'}
          </p>
          <button
            onClick={this.reset}
            className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-[24px] border-none bg-teal text-white text-[12.5px] font-bold tracking-[0.04em] cursor-pointer transition-all hover:-translate-y-px"
            style={{ boxShadow: '0 4px 14px rgba(61,139,122,0.25)' }}
          >
            再試行
          </button>
        </div>
      </div>
    )
  }
}

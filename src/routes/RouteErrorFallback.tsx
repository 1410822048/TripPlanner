// src/routes/RouteErrorFallback.tsx
// Fallback UI used by ErrorBoundary at the route level. Offers a "go home"
// action that bypasses the broken route entirely — safer than a bare retry
// when a page's data is the cause of the crash (retrying the same broken
// component just re-throws).
import { useNavigate } from 'react-router-dom'

interface Props {
  error: Error
  reset: () => void
}

export default function RouteErrorFallback({ error, reset }: Props) {
  const navigate = useNavigate()

  function goHome() {
    reset()
    navigate('/schedule', { replace: true })
  }

  return (
    <div className="fixed inset-0 max-w-[430px] mx-auto bg-app flex flex-col items-center justify-center px-6 text-center">
      <div className="text-[44px] mb-2">⚠️</div>
      <h1 className="m-0 mb-2 text-[18px] font-black text-ink">
        このページを表示できません
      </h1>
      <p className="m-0 mb-5 text-[12px] text-muted leading-[1.7] tracking-[0.02em] max-w-[280px] break-words">
        {error.message || '不明なエラーが発生しました'}
      </p>
      <div className="flex gap-2.5">
        <button
          onClick={reset}
          className="h-11 px-5 rounded-chip border border-border bg-surface text-ink text-[12.5px] font-semibold cursor-pointer hover:bg-tile transition-colors"
        >
          再試行
        </button>
        <button
          onClick={goHome}
          className="h-11 px-5 rounded-chip border-none bg-teal text-white text-[12.5px] font-bold tracking-[0.04em] cursor-pointer transition-all hover:-translate-y-px"
          style={{ boxShadow: '0 4px 14px rgba(61,139,122,0.25)' }}
        >
          ホームに戻る
        </button>
      </div>
    </div>
  )
}

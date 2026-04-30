// src/components/ui/NoTripEmptyState.tsx
// Empty state for feature pages when the signed-in user has no trips.
// `reason` is plugged into a fixed Japanese sentence — pass the verb
// phrase only (e.g. "予約を管理" → "予約を管理できるようになります。").
import type { LucideIcon } from 'lucide-react'

interface Props {
  icon:   LucideIcon
  reason: string
}

export default function NoTripEmptyState({ icon: Icon, reason }: Props) {
  return (
    <div className="bg-app min-h-full flex flex-col items-center justify-center px-6 py-10">
      <div className="w-14 h-14 rounded-full bg-surface border border-border flex items-center justify-center mb-4 text-muted">
        <Icon size={22} strokeWidth={1.6} />
      </div>
      <h2 className="m-0 mb-1.5 text-[17px] font-bold text-ink -tracking-[0.3px]">
        旅程がありません
      </h2>
      <p className="m-0 text-[12px] text-muted text-center max-w-[260px] leading-[1.7] tracking-[0.02em]">
        「行程」タブで旅程を作成すると、<br />
        {reason}できるようになります。
      </p>
    </div>
  )
}

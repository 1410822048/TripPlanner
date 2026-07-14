// src/features/wish/components/WishVotingDeadlineBar.tsx
// Owner-only entry point + status display for the trip's shared Wish
// voting deadline. Two independent flags drive it (see WishPage):
//   - votingClosed: deadline has passed — wish CRUD is locked for everyone
//     (mirrors firestore.rules' wishVotingOpen(tripId)).
//   - deadlineLocked: the Worker sweep already stamped
//     wishVotingDeadlineNotifiedAt — the owner can no longer edit the
//     deadline itself (mirrors the owner-update rule's guard). Once
//     locked there's no edit entry point at all, since rules would
//     reject the write anyway.
import { Clock, AlertCircle } from 'lucide-react'
import type { Timestamp } from 'firebase/firestore'

interface Props {
  deadlineAt:     Timestamp | null
  /** Captured once by the caller (React Compiler forbids impure Date.now()
   *  calls during render) — see WishPage's `useState(() => Date.now())`. */
  now:            number
  votingClosed:   boolean
  deadlineLocked: boolean
  isOwner:        boolean
  /** True while a setWishVotingDeadline mutation is in flight. Blocks
   *  reopening the sheet — WishDeadlineSheet closes synchronously on save
   *  (optimistic-close, mirrors the rest of this page), so without this
   *  guard the owner could reopen mid-mutation and fire a second concurrent
   *  write whose rollback could clobber the first one's result. */
  isSaving:       boolean
  onOpenSheet:    () => void
}

function daysLeftLabel(deadlineAt: Timestamp, now: number): string {
  const msLeft = deadlineAt.toMillis() - now
  const daysLeft = Math.ceil(msLeft / 86_400_000)
  return daysLeft > 1 ? `剩 ${daysLeft} 天` : '即將截止'
}

function formatDeadline(deadlineAt: Timestamp): string {
  const d = deadlineAt.toDate()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${mm}/${dd} ${hh}:${min}`
}

export default function WishVotingDeadlineBar({
  deadlineAt, now, votingClosed, deadlineLocked, isOwner, isSaving, onOpenSheet,
}: Props) {
  if (votingClosed) {
    return (
      <div className="shrink-0 mx-4 mb-2 flex items-center gap-2 px-3 py-2.5 rounded-xl bg-danger-pale border border-danger/20">
        <AlertCircle size={15} className="shrink-0 text-danger" />
        <span className="text-[12px] font-semibold text-danger">投票已截止</span>
      </div>
    )
  }

  if (!deadlineAt) {
    if (!isOwner) return null
    return (
      <div className="shrink-0 px-4 pb-2">
        <button
          type="button"
          disabled={isSaving}
          onClick={onOpenSheet}
          className="w-full h-9 rounded-[14px] border border-border bg-transparent text-muted text-[11.5px] font-semibold flex items-center justify-center gap-1.5 cursor-pointer transition-colors hover:bg-app disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Clock size={13} strokeWidth={2} />
          設定投票截止時間
        </button>
      </div>
    )
  }

  const clickable = isOwner && !deadlineLocked && !isSaving

  return (
    <div className="shrink-0 mx-4 mb-2">
      <button
        type="button"
        disabled={!clickable}
        onClick={clickable ? onOpenSheet : undefined}
        className={[
          'w-full flex items-center gap-2 px-3 py-2.5 rounded-xl border bg-app border-border text-[12px] font-semibold text-muted',
          clickable ? 'cursor-pointer hover:bg-surface transition-colors' : 'cursor-default',
        ].join(' ')}
      >
        <Clock size={14} className="shrink-0 text-muted" />
        <span className="flex-1 text-left">截止：{formatDeadline(deadlineAt)}</span>
        <span className="text-[10.5px] font-medium tabular-nums opacity-70">{daysLeftLabel(deadlineAt, now)}</span>
      </button>
    </div>
  )
}

// src/features/expense/components/SwipeableExpenseItem.tsx
// 費用列表 row — 左滑露出刪除。Gesture mechanics + shell markup live in
// SwipeableShell so the body here is just per-row layout + content.
//
// Swipe affordance is permission-gated by the caller: when delete
// permission isn't available (viewer role), the swipe props +
// onDelete are omitted and the shell renders a plain non-swipeable
// row. Tap-to-edit still works in that branch — viewers can read
// details.
import { Loader2 } from 'lucide-react'
import type { Expense } from '@/types'
import type { TripMember } from '@/features/trips/types'
import SwipeableShell from '@/components/ui/SwipeableShell'
import { formatAmount } from '@/utils/currency'

export interface SwipeableExpenseItemProps {
  expense:      Expense
  payer:        TripMember | undefined
  summary:      string
  categoryEmoji: string
  /** ISO currency code from the trip. Threaded as a prop (rather than
   *  read via useTripCurrency inside) so the memo comparator can
   *  invalidate when the user changes currency mid-trip. */
  currency:     string
  /** Tap on the row body — opens the edit modal. Optional: viewers
   *  (no write permission) omit it; the row then has no cursor / click,
   *  mirroring firestore.rules so save isn't reached. */
  onSelect?:    () => void
  /** Swipe-state controlled by parent (useSwipeOpen). Optional — when
   *  any of these are absent the row renders without swipe affordance
   *  (viewers, or pending optimistic rows). */
  isOpen?:      boolean
  onOpen?:      () => void
  onClose?:     () => void
  onDelete?:    () => void
}

function SwipeableExpenseItem({
  expense, payer, summary, categoryEmoji, currency,
  isOpen, onSelect, onOpen, onClose, onDelete,
}: SwipeableExpenseItemProps) {
  // Rows added via optimistic update carry a `temp-` prefixed id until
  // the Firestore + Storage round-trip lands. While pending we disable
  // tap-to-edit (the doc isn't on the server yet so updateDoc would
  // fail) and swipe-to-delete, and dim the row + show a spinner so the
  // user knows it's still saving.
  const isPending = expense.id.startsWith('temp-')

  // Receipt thumbnail (if image + thumb exists) replaces the category
  // emoji tile. PDFs without thumbnails keep the emoji — the file-type
  // is still visible via the form modal's preview button when editing.
  const thumb = expense.receipt?.thumbUrl

  return (
    <SwipeableShell
      className="rounded-xl border border-border"
      onSelect={onSelect}
      isOpen={isOpen}
      onOpen={onOpen}
      onClose={onClose}
      onDelete={onDelete}
      disabled={isPending}
    >
      <div className={[
        'flex items-center gap-3 px-3 py-2.5 transition-opacity',
        isPending ? 'opacity-55' : '',
      ].join(' ')}>
        <div className="w-9 h-9 rounded-input bg-tile shrink-0 flex items-center justify-center text-[17px] overflow-hidden pointer-events-none"
             style={thumb ? { backgroundImage: `url(${thumb})`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}>
          {thumb ? null : categoryEmoji}
        </div>
        <div className="flex-1 min-w-0 pointer-events-none">
          <div className="text-[13px] font-semibold text-ink -tracking-[0.1px] overflow-hidden text-ellipsis whitespace-nowrap">
            {expense.title}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5 text-[10.5px] text-muted">
            {isPending ? (
              <>
                <Loader2 size={11} strokeWidth={2.2} className="animate-spin shrink-0" />
                <span>保存中…</span>
              </>
            ) : (
              <>
                {payer && (
                  <>
                    <span
                      className="inline-flex items-center justify-center w-[14px] h-[14px] rounded-full text-[8px] font-bold shrink-0"
                      style={{ background: payer.bg, color: payer.color }}
                    >
                      {payer.label}
                    </span>
                    <span>立替</span>
                    <span className="text-border">·</span>
                  </>
                )}
                <span>{summary}</span>
              </>
            )}
          </div>
        </div>
        <div className="text-[14px] font-bold text-ink tabular-nums shrink-0 pointer-events-none">
          {formatAmount(expense.amount, currency)}
        </div>
      </div>
    </SwipeableShell>
  )
}

export default SwipeableExpenseItem

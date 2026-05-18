// src/features/expense/components/SwipeableExpenseItem.tsx
// 費用列表 row — 左滑露出刪除。Gesture mechanics live in useSwipeRow
// so the body here is just layout + content per row.
//
// Swipe affordance is permission-gated by the caller: when delete
// permission isn't available (viewer role), the swipe props +
// onDelete are omitted and we render a plain non-swipeable row.
// Tap-to-edit still works in that branch — viewers can read details.
import { Loader2, Trash2 } from 'lucide-react'
import type { Expense } from '@/types'
import type { TripMember } from '@/features/trips/types'
import { useSwipeRow, SWIPE_WIDTH, BG_TRANSITION, FG_TRANSITION } from '@/hooks/useSwipeRow'
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
  const swipeable = !!onDelete && !!onOpen && !!onClose && !isPending
  const {
    bindFg, bindBg, pointerProps, deleteProps, openX, confirming, wrapTap,
  } = useSwipeRow({ isOpen: !!isOpen, onOpen, onClose, onDelete, enabled: swipeable })

  // Receipt thumbnail (if image + thumb exists) replaces the category
  // emoji tile. PDFs without thumbnails keep the emoji — the file-type
  // is still visible via the form modal's preview button when editing.
  const thumb = expense.receipt?.thumbUrl
  const body = (
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
  )

  // Non-swipeable branch covers two cases:
  //   1. Pending optimistic row (`isPending`) — tap blocked because the
  //      doc isn't on the server yet, updateDoc would fail.
  //   2. Viewer (`!onSelect`) — no edit permission, so tap-to-edit is
  //      not offered at all (firestore.rules would reject the save).
  // Both render the same dimmed-or-plain card without click handler.
  const clickable = !!onSelect && !isPending
  if (!swipeable) {
    return (
      <div
        onClick={clickable ? onSelect : undefined}
        className={[
          'relative rounded-xl overflow-hidden bg-surface border border-border select-none',
          clickable ? 'cursor-pointer' : 'cursor-default',
        ].join(' ')}
      >
        {body}
      </div>
    )
  }

  return (
    <div className="relative rounded-xl overflow-hidden bg-surface border border-border">
      {/* 刪除背景按鈕 */}
      <div
        ref={bindBg}
        {...deleteProps}
        className={[
          'absolute top-0 right-0 bottom-0 flex items-center justify-center cursor-pointer',
          confirming ? 'bg-[#A83A3A]' : 'bg-[#D85A5A]',
        ].join(' ')}
        style={{
          width: SWIPE_WIDTH,
          transform: `translate3d(${SWIPE_WIDTH + openX}px,0,0)`,
          transition: BG_TRANSITION,
          pointerEvents: openX < 0 ? 'auto' : 'none',
        }}
      >
        {confirming ? (
          <div className="text-white text-[11px] font-bold tracking-[0.04em] text-center leading-[1.3]">
            確認<br/>削除
          </div>
        ) : (
          <div className="flex flex-col items-center gap-0.5">
            <Trash2 size={18} color="white" strokeWidth={2.2} />
            <span className="text-white text-[10px] font-bold tracking-[0.04em]">
              削除
            </span>
          </div>
        )}
      </div>

      {/* 前景內容層 — swipeable 分支 implies onSelect 通常存在(因為
          canWrite gate 同時開啟 swipe 跟 onSelect),但仍保留 conditional
          以免未來 props 組合改變時失序。 */}
      <div
        ref={bindFg}
        {...pointerProps}
        onClick={onSelect ? wrapTap(onSelect) : undefined}
        className={[
          'relative select-none bg-surface',
          onSelect ? 'cursor-pointer' : '',
        ].join(' ')}
        style={{
          transform: `translate3d(${openX}px,0,0)`,
          transition: FG_TRANSITION,
          touchAction: 'pan-y',
          WebkitTouchCallout: 'none',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        {body}
      </div>
    </div>
  )
}

export default SwipeableExpenseItem

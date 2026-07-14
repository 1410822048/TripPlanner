// src/features/expense/components/SwipeableExpenseItem.tsx
// 費用列表 row — 左滑露出刪除。Gesture mechanics + shell markup live in
// SwipeableShell so the body here is just per-row layout + content.
//
// Swipe affordance is permission-gated by the caller: when delete
// permission isn't available (viewer role), the swipe props +
// onDelete are omitted and the shell renders a plain non-swipeable
// row. Row tap opens the read-first detail surface; edit is launched
// from that detail sheet when the caller permits it.
import { Loader2, Lock, Receipt, type LucideIcon } from 'lucide-react'
import type { Expense } from '@/types'
import type { TripMember } from '@/features/trips/types'
import MemberAvatar from '@/components/ui/MemberAvatar'
import SwipeableShell from '@/components/ui/SwipeableShell'
import { useAttachmentUrl } from '@/hooks/useAttachmentUrl'
import { formatMinorAmount } from '@/utils/money'

interface SwipeableExpenseItemProps {
  expense:      Expense
  payer:        TripMember | undefined
  summary:      string
  categoryIcon: LucideIcon
  /** ISO currency code from the trip. Threaded as a prop (rather than
   *  read via useTripCurrency inside) so the memo comparator can
   *  invalidate when the user changes currency mid-trip. */
  currency:     string
  /** Tap on the row body — opens the expense detail surface. */
  onSelect?:    () => void
  /** Tap on the receipt thumbnail; separate from row select so the
   *  image opens a receipt preview instead of the detail/edit flow. */
  onPreviewReceipt?: () => void
  /** True when this row's UPDATE mutation is in-flight. Pages derive the
   *  set via `usePendingMutationIds`. CREATE pending is detected here
   *  via the `temp-` id prefix; UPDATE preserves the real server id and
   *  needs this signal to surface the same 保存中… visual. */
  isUpdating?:  boolean
  /** Settled-source row locked for non-owner editors. */
  isLocked?:    boolean
  /** Swipe-state controlled by parent (useSwipeOpen). Optional — when
   *  any of these are absent the row renders without swipe affordance
   *  (viewers, or pending optimistic rows). */
  isOpen?:      boolean
  onOpen?:      () => void
  onClose?:     () => void
  onDelete?:    () => void
}

function SwipeableExpenseItem({
  expense, payer, summary, categoryIcon: CategoryIcon, currency,
  isOpen, isUpdating, isLocked, onSelect, onPreviewReceipt, onOpen, onClose, onDelete,
}: SwipeableExpenseItemProps) {
  // Rows added via optimistic update carry a `temp-` prefixed id until
  // the Firestore + Storage round-trip lands. UPDATE mutations preserve
  // the real id, so the page also passes `isUpdating` (derived from
  // `useMutationState`). Either signal disables tap-to-edit + swipe-to-
  // delete and dims the row + shows a spinner.
  const isPending = expense.id.startsWith('temp-') || !!isUpdating

  // Receipt thumbnail (if image + thumb exists) replaces the category
  // icon tile. PDFs without thumbnails keep the icon — the file-type
  // is still visible via the form modal's preview button when editing.
  // path-only: resolve the thumb path to a blob objectURL via Storage Rules.
  const thumb = useAttachmentUrl(expense.receipt?.thumbPath, { kind: 'thumb' })

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
      {({ clickable, selectButtonProps }) => {
        const iconTile = (
          <div className="w-11 h-11 rounded-input bg-tile shrink-0 flex items-center justify-center text-muted overflow-hidden pointer-events-none">
            {thumb ? (
              <img src={thumb} alt="" className="w-full h-full object-cover" draggable={false} />
            ) : (
              <CategoryIcon size={18} strokeWidth={1.8} />
            )}
          </div>
        )
        const rowMain = (
          <>
            {!onPreviewReceipt && iconTile}
            <div className="flex-1 min-w-0 pointer-events-none">
              <div className="text-[13px] font-semibold text-ink -tracking-[0.1px] overflow-hidden text-ellipsis whitespace-nowrap">
                {expense.title}
              </div>
              <div className="flex items-center gap-1.5 mt-0.5 text-[10.5px] text-muted">
                {isPending ? (
                  <>
                    <Loader2 size={11} strokeWidth={2.2} className="animate-spin shrink-0" />
                    <span>儲存中…</span>
                  </>
                ) : isLocked ? (
                  <>
                    <Lock size={11} strokeWidth={2.2} className="shrink-0" />
                    <span>已清算</span>
                  </>
                ) : (
                  <>
                    {payer && (
                      <>
                        <MemberAvatar member={payer} size={14} />
                        <span>立替</span>
                        <span className="text-border">·</span>
                      </>
                    )}
                    <span>{summary}</span>
                  </>
                )}
              </div>
            </div>
            {/* Foreign expenses surface two amounts stacked: the trip-currency
                canonical (authoritative — what Settlement math + totals see)
                in the primary row, and the source-domain receipt amount in a
                muted secondary line. Domestic expenses keep the single-amount
                layout. Per-Phase-3 contract: when sourceCurrency is present,
                sourceAmountMinor is ALSO present (FX group invariant in
                ExpenseDocSchema superRefine), so the `!` assertions hold. */}
            <div className="flex flex-col items-end shrink-0 pointer-events-none">
              <div className="text-[14px] font-bold text-ink tabular-nums">
                {formatMinorAmount(expense.amountMinor, currency)}
              </div>
              {expense.sourceCurrency && expense.sourceCurrency !== currency && (
                <div className="text-[10.5px] text-muted tabular-nums leading-tight mt-0.5">
                  {formatMinorAmount(expense.sourceAmountMinor!, expense.sourceCurrency)}
                </div>
              )}
            </div>
          </>
        )

        return (
          <div className={[
            'flex items-center gap-3 px-3 py-2.5 transition-opacity',
            isPending ? 'opacity-55' : '',
          ].join(' ')}>
            {onPreviewReceipt && (
              <button
                type="button"
                onPointerDown={e => e.stopPropagation()}
                onClick={e => {
                  e.stopPropagation()
                  onPreviewReceipt()
                }}
                disabled={isPending}
                aria-label="顯示收據"
                className="w-11 h-11 rounded-input border-none bg-tile shrink-0 flex items-center justify-center text-muted overflow-hidden cursor-pointer disabled:cursor-default disabled:opacity-60 transition-transform active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {thumb ? (
                  <img src={thumb} alt="" className="w-full h-full object-cover" draggable={false} />
                ) : (
                  <Receipt size={18} strokeWidth={1.8} />
                )}
              </button>
            )}
            {clickable ? (
              <button
                {...selectButtonProps}
                aria-label={`顯示 ${expense.title} 的詳細資料`}
                className="flex flex-1 min-w-0 items-center gap-3 p-0 border-none bg-transparent text-left text-inherit cursor-pointer disabled:cursor-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {rowMain}
              </button>
            ) : (
              <div className="flex flex-1 min-w-0 items-center gap-3">
                {rowMain}
              </div>
            )}
          </div>
        )
      }}
    </SwipeableShell>
  )
}

export default SwipeableExpenseItem

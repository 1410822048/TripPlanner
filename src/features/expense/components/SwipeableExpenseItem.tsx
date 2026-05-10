// src/features/expense/components/SwipeableExpenseItem.tsx
// 費用列表 row — 左滑露出刪除。Gesture mechanics live in useSwipeRow
// so the body here is just layout + content per row.
//
// Swipe affordance is permission-gated by the caller: when delete
// permission isn't available (viewer role), the swipe props +
// onDelete are omitted and we render a plain non-swipeable row.
// Tap-to-edit still works in that branch — viewers can read details.
import { memo } from 'react'
import { Trash2 } from 'lucide-react'
import type { Expense } from '@/types'
import type { TripMember } from '@/features/trips/types'
import { useSwipeRow, SWIPE_WIDTH, BG_TRANSITION, FG_TRANSITION } from '@/hooks/useSwipeRow'

export interface SwipeableExpenseItemProps {
  expense:      Expense
  payer:        TripMember | undefined
  summary:      string
  categoryEmoji: string
  onSelect:     () => void
  /** Swipe-state controlled by parent (useSwipeOpen). Optional — when
   *  any of these are absent the row renders without swipe affordance
   *  (used for viewers without delete permission). */
  isOpen?:      boolean
  onOpen?:      () => void
  onClose?:     () => void
  onDelete?:    () => void
}

function SwipeableExpenseItem({
  expense, payer, summary, categoryEmoji,
  isOpen, onSelect, onOpen, onClose, onDelete,
}: SwipeableExpenseItemProps) {
  const swipeable = !!onDelete && !!onOpen && !!onClose
  const {
    bindFg, bindBg, pointerProps, deleteProps, openX, confirming, wrapTap,
  } = useSwipeRow({ isOpen: !!isOpen, onOpen, onClose, onDelete, enabled: swipeable })

  const body = (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <div className="w-9 h-9 rounded-input bg-tile shrink-0 flex items-center justify-center text-[17px] pointer-events-none">
        {categoryEmoji}
      </div>
      <div className="flex-1 min-w-0 pointer-events-none">
        <div className="text-[13px] font-semibold text-ink -tracking-[0.1px] overflow-hidden text-ellipsis whitespace-nowrap">
          {expense.title}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 text-[10.5px] text-muted">
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
        </div>
      </div>
      <div className="text-[14px] font-bold text-ink tabular-nums shrink-0 pointer-events-none">
        ¥{expense.amount.toLocaleString()}
      </div>
    </div>
  )

  // Non-swipeable branch: viewers without delete permission get a plain
  // tap-to-edit row. Pointer handlers omitted entirely so there's no
  // chance of a half-armed gesture.
  if (!swipeable) {
    return (
      <div
        onClick={onSelect}
        className="relative rounded-xl overflow-hidden bg-surface border border-border cursor-pointer select-none"
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

      {/* 前景內容層 */}
      <div
        ref={bindFg}
        {...pointerProps}
        onClick={wrapTap(onSelect)}
        className="relative select-none cursor-pointer bg-surface"
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

// callback props 在 parent render 時每次都是新 ref — 自訂 compare 忽略它們，
// 只看會影響渲染結果的 primitive / stable-ref props。
export default memo(SwipeableExpenseItem, (prev, next) => (
  prev.expense === next.expense &&
  prev.payer === next.payer &&
  prev.summary === next.summary &&
  prev.categoryEmoji === next.categoryEmoji &&
  prev.isOpen === next.isOpen
))

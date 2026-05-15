// src/features/planning/components/PlanningRow.tsx
// One row in the planning checklist. Swipe-left reveals a red delete
// button — same gesture + tap-to-confirm UX as SwipeableBookingItem /
// SwipeableTripItem. Body tap opens edit; checkbox tap toggles done.
//
// When the row is swiped open, taps on either the body or the checkbox
// are short-circuited to "close the row" so the user can dismiss the
// delete affordance without accidentally toggling state.
import { Check, Trash2 } from 'lucide-react'
import type { PlanItem } from '@/types'
import { useSwipeRow, SWIPE_WIDTH, BG_TRANSITION, FG_TRANSITION } from '@/hooks/useSwipeRow'

interface Props {
  item:          PlanItem
  /** True in demo mode — visually dim the row so users sense it's "not
   *  real yet", but the click still fires so the parent can surface the
   *  sign-in prompt. */
  isPreviewOnly: boolean
  isOpen:        boolean
  onToggleDone:  () => void
  onTap:         () => void
  onOpen:        () => void
  onClose:       () => void
  onDelete:      () => void
}

function PlanningRow({
  item, isPreviewOnly, isOpen,
  onToggleDone, onTap, onOpen, onClose, onDelete,
}: Props) {
  const {
    bindFg, bindBg, pointerProps, deleteProps, openX, confirming, wrapTap,
  } = useSwipeRow({ isOpen, onOpen, onClose, onDelete })

  return (
    <div className={[
      'relative rounded-[14px] overflow-hidden bg-surface border border-border transition-opacity',
      item.done ? 'opacity-60' : 'opacity-100',
    ].join(' ')}>
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

      <div
        ref={bindFg}
        {...pointerProps}
        className="relative select-none flex items-stretch gap-2 bg-surface"
        style={{
          transform: `translate3d(${openX}px,0,0)`,
          transition: FG_TRANSITION,
          touchAction: 'pan-y',
          WebkitTouchCallout: 'none',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <button
          onClick={wrapTap(onToggleDone)}
          aria-pressed={item.done}
          aria-label={item.done ? 'チェック解除' : 'チェック'}
          className={[
            'shrink-0 w-12 flex items-center justify-center bg-transparent border-none border-r border-border cursor-pointer transition-colors hover:bg-app',
            isPreviewOnly ? 'opacity-70' : 'opacity-100',
          ].join(' ')}
        >
          <div className={[
            'w-5 h-5 rounded-md border-[2px] flex items-center justify-center transition-colors',
            item.done ? 'border-accent bg-accent' : 'border-border bg-app',
          ].join(' ')}>
            {item.done && <Check size={13} strokeWidth={3} className="text-white" />}
          </div>
        </button>

        <button
          onClick={wrapTap(onTap)}
          className="flex-1 min-w-0 px-3 py-2.5 text-left bg-transparent border-none cursor-pointer hover:bg-app transition-colors"
        >
          <div className={[
            'text-[13.5px] font-semibold text-ink truncate',
            item.done ? 'line-through' : '',
          ].join(' ')}>
            {item.title}
          </div>
          {item.note && (
            <div className="text-[11px] text-muted mt-0.5 truncate">
              {item.note}
            </div>
          )}
        </button>
      </div>
    </div>
  )
}

export default PlanningRow

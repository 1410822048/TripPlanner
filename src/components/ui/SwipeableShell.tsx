// src/components/ui/SwipeableShell.tsx
// Shared swipe-to-delete shell — owns the red delete background, the
// gesture-driven foreground transform, and the non-swipeable fallback
// branch used when the caller has no delete permission (viewer) or the
// row is in a pending/optimistic state.
//
// Body content is delegated to children: callers compose whatever
// layout they want (booking dispatcher / expense row / future rows).
// Pre-extraction this exact markup lived inline in two places
// (~70 lines each) — see /simplify pass that produced this primitive.
//
// PlanningRow is intentionally NOT migrated: its foreground splits into
// two separately-wrapped buttons (checkbox + tap-to-edit) and the
// children-as-body shape doesn't fit that layout.
import { Trash2 } from 'lucide-react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import {
  useSwipeRow, SWIPE_WIDTH, BG_TRANSITION, FG_TRANSITION,
} from '@/hooks/useSwipeRow'

interface SwipeableShellRenderProps {
  clickable: boolean
  selectButtonProps: {
    type: 'button'
    disabled: boolean
    onClick?: (e: ReactMouseEvent<HTMLButtonElement>) => void
  }
}

type SwipeableShellChildren =
  | ReactNode
  | ((props: SwipeableShellRenderProps) => ReactNode)

interface SwipeableShellProps {
  /** Outer wrapper extra classes — pass the radius / border / shadow
   *  the calling feature wants (e.g. `rounded-xl border border-border`). */
  className?: string
  /** Whole-row tap for legacy row bodies, or the select action exposed
   *  to render-prop children that need a nested native button. */
  onSelect?: () => void
  /** Swipe-state controlled by parent (useSwipeOpen). When any of
   *  these are absent OR `disabled` is true, the row renders without
   *  swipe affordance — used for viewers without delete permission
   *  and for optimistic-pending rows. */
  isOpen?: boolean
  onOpen?: () => void
  onClose?: () => void
  onDelete?: () => void
  /** Force-disable both swipe AND tap. Used for optimistic `temp-*`
   *  rows in the expense list while the Firestore + Storage round-trip
   *  is in flight. */
  disabled?: boolean
  /** Two-step delete confirm. Default true (data rows). Pass false for
   *  non-destructive one-tap dismissals (e.g. notification inbox). */
  confirmDelete?: boolean
  children: SwipeableShellChildren
}

function SwipeableShell({
  className, onSelect, isOpen, onOpen, onClose, onDelete, disabled = false,
  confirmDelete = true, children,
}: SwipeableShellProps) {
  const swipeable = !!onDelete && !!onOpen && !!onClose && !disabled
  const clickable = !!onSelect && !disabled
  const {
    bindFg, bindBg, pointerProps, deleteProps, openX, confirming, wrapTap,
  } = useSwipeRow({ isOpen: !!isOpen, onOpen, onClose, onDelete, enabled: swipeable, confirmDelete })

  const wrapperBase = 'relative overflow-hidden bg-surface'
  const childOwnsSelect = typeof children === 'function'
  const plainSelect = (e: ReactMouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    onSelect?.()
  }
  const selectButtonProps: SwipeableShellRenderProps['selectButtonProps'] = {
    type: 'button',
    disabled: !clickable,
    onClick: clickable
      ? (swipeable ? wrapTap(onSelect!) : plainSelect)
      : undefined,
  }
  const content = childOwnsSelect
    ? children({ clickable, selectButtonProps })
    : children

  if (!swipeable) {
    return (
      <div
        onClick={!childOwnsSelect && clickable ? onSelect : undefined}
        className={[
          wrapperBase,
          'select-none',
          className ?? '',
          clickable ? 'cursor-pointer' : '',
        ].join(' ')}
      >
        {content}
      </div>
    )
  }

  const iconOnlyAction = !confirmDelete

  return (
    <div className={[wrapperBase, className ?? ''].join(' ')}>
      <div
        ref={bindBg}
        {...deleteProps}
        className={[
          'absolute top-0 right-0 bottom-0 flex items-center justify-center cursor-pointer',
          iconOnlyAction
            ? 'bg-transparent'
            : (confirming ? 'bg-[#A83A3A]' : 'bg-[#D85A5A]'),
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
            確認<br/>刪除
          </div>
        ) : iconOnlyAction ? (
          <span
            className="flex h-11 w-11 items-center justify-center rounded-full bg-[#D85A5A] text-white shadow-[0_6px_16px_rgba(216,90,90,0.24)]"
            aria-hidden
          >
            <Trash2 size={18} strokeWidth={2.2} />
          </span>
        ) : (
          <div className="flex flex-col items-center gap-0.5">
            <Trash2 size={18} color="white" strokeWidth={2.2} />
            <span className="text-white text-[10px] font-bold tracking-[0.04em]">
              刪除
            </span>
          </div>
        )}
      </div>

      <div
        ref={bindFg}
        {...pointerProps}
        onClick={!childOwnsSelect && clickable ? wrapTap(onSelect!) : undefined}
        className={[
          'relative select-none bg-surface',
          clickable ? 'cursor-pointer' : '',
        ].join(' ')}
        style={{
          transform: `translate3d(${openX}px,0,0)`,
          transition: FG_TRANSITION,
          touchAction: 'pan-y',
          WebkitTouchCallout: 'none',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        {content}
      </div>
    </div>
  )
}

export default SwipeableShell

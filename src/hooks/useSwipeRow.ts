// src/hooks/useSwipeRow.ts
// Swipe-to-delete row gesture mechanics. Replaces the ~80-line copy
// pasted across SwipeableExpenseItem / SwipeableBookingItem /
// PlanningRow / WishCard. Each of those used to declare:
//
//   - drag = useRef({ startX, startY, currentX, dragging, mode, didDrag })
//   - writeTransform(x) — write fg.transform + bg.transform via refs
//   - onPointerDown / Move / Up / Cancel handlers
//   - confirming state + reset effect on isOpen=false
//   - handleDeleteTap two-step confirm
//
// All identical. Now they share this hook; component bodies stay
// per-row custom (avatar + name vs thumbnail + code vs cover image
// vs etc.).
//
// Not used by SwipeableTripItem — that one folds long-press reorder
// into the SAME pointer handlers, so the gesture state machine has
// extra modes ('swipe' | 'reorder'). Keeping it bespoke avoids a
// hook with 'maybe-reorder' branches that would obscure both flows.
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  SWIPE_WIDTH, OPEN_THRESHOLD, MOVE_THRESHOLD,
  FG_TRANSITION, BG_TRANSITION,
} from '@/components/ui/swipeConstants'

export interface UseSwipeRowProps {
  isOpen:  boolean
  /** Callbacks are optional so callers without delete permission can
   *  pass `enabled: false` and skip wiring no-op handlers. The hook
   *  no-ops internally when `enabled` is false (pointer handlers
   *  short-circuit, deleteProps is harmless). */
  onOpen?:  () => void
  onClose?: () => void
  onDelete?: () => void
  /** When false, the hook short-circuits — pointer handlers no-op,
   *  openX stays 0, wrapTap passes through. Lets a row hide the swipe
   *  affordance when the caller has no delete permission. */
  enabled?: boolean
}

export interface UseSwipeRowResult {
  /** Callback ref for the foreground (sliding) div: `<div ref={bindFg}>`.
   *  Callback rather than RefObject to keep the hook's return surface
   *  free of `RefObject<T>` — the new react-hooks/refs lint rule taints
   *  any property access on objects whose fields are typed as refs. */
  bindFg: (el: HTMLDivElement | null) => void
  /** Callback ref for the red delete-background div. */
  bindBg: (el: HTMLDivElement | null) => void
  /** Spread onto the foreground div: `<div {...pointerProps}>`. */
  pointerProps: {
    onPointerDown:   (e: React.PointerEvent) => void
    onPointerMove:   (e: React.PointerEvent) => void
    onPointerUp:     (e: React.PointerEvent) => void
    onPointerCancel: (e: React.PointerEvent) => void
    onContextMenu:   (e: React.MouseEvent) => void
  }
  /** X offset in px. -SWIPE_WIDTH when open, 0 when closed. */
  openX: number
  /** True after the user has tapped the red delete button once.
   *  Caller renders "確認削除" text in this state and waits for the
   *  second tap (which fires onDelete via deleteProps.onClick). */
  confirming: boolean
  /** Spread onto the delete-background div: `<div {...deleteProps}>`. */
  deleteProps: {
    onClick: (e: React.MouseEvent) => void
  }
  /** Wrap an inner button's primary action so it correctly handles
   *  the three special cases:
   *    - just-finished a swipe drag → swallow the click
   *    - row currently open → close the row instead of the action
   *    - otherwise → run the action
   *  All wrapped handlers stopPropagation so the page-wrapper
   *  close-on-outside-tap doesn't double-fire. */
  wrapTap: (action: () => void) => (e: React.MouseEvent) => void
}

export function useSwipeRow({
  isOpen, onOpen, onClose, onDelete, enabled = true,
}: UseSwipeRowProps): UseSwipeRowResult {
  const [confirming, setConfirming] = useState(false)
  const fgRef = useRef<HTMLDivElement | null>(null)
  const bgRef = useRef<HTMLDivElement | null>(null)
  const bindFg = useCallback((el: HTMLDivElement | null) => { fgRef.current = el }, [])
  const bindBg = useCallback((el: HTMLDivElement | null) => { bgRef.current = el }, [])
  const drag  = useRef({
    startX: 0, startY: 0,
    currentX: 0,
    dragging: false,
    mode: null as 'swipe' | null,
    didDrag: false,
  })

  // Reset the "tap once to confirm" gate when the row swipes shut.
  useEffect(() => {
    if (!isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConfirming(false)
    }
  }, [isOpen])

  function writeTransform(x: number) {
    drag.current.currentX = x
    const fg = fgRef.current, bg = bgRef.current
    if (fg) fg.style.transform = `translate3d(${x}px,0,0)`
    if (bg) {
      bg.style.transform = `translate3d(${SWIPE_WIDTH + x}px,0,0)`
      bg.style.pointerEvents = x < 0 ? 'auto' : 'none'
    }
  }

  function onPointerDown(e: React.PointerEvent) {
    if (!enabled) return
    drag.current.startX   = e.clientX
    drag.current.startY   = e.clientY
    drag.current.mode     = null
    drag.current.didDrag  = false
    drag.current.dragging = true
    const fg = fgRef.current, bg = bgRef.current
    if (fg) { fg.style.transition = 'none'; fg.style.willChange = 'transform' }
    if (bg) { bg.style.transition = 'background 0.15s'; bg.style.willChange = 'transform' }
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) }
    catch { /* some browsers throw on pointer capture — ignore */ }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!enabled || !drag.current.dragging) return
    const dx = e.clientX - drag.current.startX
    const dy = e.clientY - drag.current.startY

    if (drag.current.mode === 'swipe') {
      drag.current.didDrag = true
      const base = isOpen ? -SWIPE_WIDTH : 0
      const next = Math.min(0, Math.max(-SWIPE_WIDTH, base + dx))
      writeTransform(next)
      return
    }

    if (Math.abs(dx) < MOVE_THRESHOLD && Math.abs(dy) < MOVE_THRESHOLD) return

    if (Math.abs(dx) > Math.abs(dy)) {
      drag.current.mode = 'swipe'
      drag.current.didDrag = true
    } else {
      drag.current.dragging = false
      try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) }
      catch { /* no-op */ }
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    if (!enabled || !drag.current.dragging) return
    drag.current.dragging = false
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) }
    catch { /* no-op */ }

    const fg = fgRef.current, bg = bgRef.current
    if (fg) fg.style.transition = FG_TRANSITION
    if (bg) bg.style.transition = BG_TRANSITION

    if (drag.current.mode === 'swipe') {
      const x = drag.current.currentX
      if (x <= -OPEN_THRESHOLD) {
        writeTransform(-SWIPE_WIDTH)
        if (!isOpen) onOpen?.()
      } else {
        writeTransform(0)
        if (isOpen) onClose?.()
      }
    }

    window.setTimeout(() => {
      if (fg) fg.style.willChange = ''
      if (bg) bg.style.willChange = ''
    }, 280)
  }

  function handleDeleteTap(e: React.MouseEvent) {
    e.stopPropagation()
    if (!confirming) { setConfirming(true); return }
    onDelete?.()
  }

  function wrapTap(action: () => void) {
    return (e: React.MouseEvent) => {
      e.stopPropagation()
      // didDrag is set during pointer-move and read on the click that
      // follows pointer-up — swallow that click so the swipe doesn't
      // also fire the row's primary action.
      if (drag.current.didDrag) { drag.current.didDrag = false; return }
      // If the row is currently swiped open, treat any inner tap as
      // "dismiss the swipe" rather than the action — matches iOS Mail's
      // behaviour and avoids the trapdoor of "I see delete revealed
      // and I tapped the row, why did it open edit?"
      if (isOpen) { onClose?.(); return }
      action()
    }
  }

  const openX = enabled && isOpen ? -SWIPE_WIDTH : 0

  return {
    bindFg,
    bindBg,
    pointerProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onContextMenu:   e => e.preventDefault(),
    },
    openX,
    confirming,
    deleteProps: { onClick: handleDeleteTap },
    wrapTap,
  }
}

// Re-export for callers that need to lay out the delete button by hand
// (width matches the gesture's reveal distance).
export { SWIPE_WIDTH, BG_TRANSITION, FG_TRANSITION }

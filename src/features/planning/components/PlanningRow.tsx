// src/features/planning/components/PlanningRow.tsx
// One row in the planning checklist. Swipe-left reveals a red delete
// button — same gesture + tap-to-confirm UX as SwipeableBookingItem /
// SwipeableTripItem. Body tap opens edit; checkbox tap toggles done.
//
// When the row is swiped open, taps on either the body or the checkbox
// are short-circuited to "close the row" so the user can dismiss the
// delete affordance without accidentally toggling state.
import { useState, useRef, useEffect, memo } from 'react'
import { Check, Trash2 } from 'lucide-react'
import type { PlanItem } from '@/types'
import {
  SWIPE_WIDTH, OPEN_THRESHOLD, MOVE_THRESHOLD,
  FG_TRANSITION, BG_TRANSITION,
} from '@/components/ui/swipeConstants'

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
  const [confirming, setConfirming] = useState(false)
  const fgRef = useRef<HTMLDivElement>(null)
  const bgRef = useRef<HTMLDivElement>(null)
  const drag  = useRef({
    startX: 0, startY: 0,
    currentX: 0,
    dragging: false,
    mode: null as 'swipe' | null,
    didDrag: false,
  })

  function writeTransform(x: number) {
    drag.current.currentX = x
    const fg = fgRef.current, bg = bgRef.current
    if (fg) fg.style.transform = `translate3d(${x}px,0,0)`
    if (bg) {
      bg.style.transform = `translate3d(${SWIPE_WIDTH + x}px,0,0)`
      bg.style.pointerEvents = x < 0 ? 'auto' : 'none'
    }
  }

  // Reset the "tap once to confirm" gate when the row swipes shut.
  useEffect(() => {
    if (!isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConfirming(false)
    }
  }, [isOpen])

  function onPointerDown(e: React.PointerEvent) {
    drag.current.startX   = e.clientX
    drag.current.startY   = e.clientY
    drag.current.mode     = null
    drag.current.didDrag  = false
    drag.current.dragging = true
    const fg = fgRef.current, bg = bgRef.current
    if (fg) { fg.style.transition = 'none'; fg.style.willChange = 'transform' }
    if (bg) { bg.style.transition = 'background 0.15s'; bg.style.willChange = 'transform' }
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) }
    catch { /* ignore */ }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current.dragging) return
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
    if (!drag.current.dragging) return
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
        if (!isOpen) onOpen()
      } else {
        writeTransform(0)
        if (isOpen) onClose()
      }
    }

    window.setTimeout(() => {
      if (fg) fg.style.willChange = ''
      if (bg) bg.style.willChange = ''
    }, 280)
  }

  // Inner buttons stop propagation so they don't fight the row's pointer
  // gesture, and short-circuit to onClose() when the row is swiped — that
  // way the user can dismiss the delete affordance with any tap on the
  // row itself, instead of being forced to swipe back.
  function handleCheckboxTap(e: React.MouseEvent) {
    e.stopPropagation()
    if (drag.current.didDrag) { drag.current.didDrag = false; return }
    if (isOpen) { onClose(); return }
    onToggleDone()
  }
  function handleBodyTap(e: React.MouseEvent) {
    e.stopPropagation()
    if (drag.current.didDrag) { drag.current.didDrag = false; return }
    if (isOpen) { onClose(); return }
    onTap()
  }

  function handleDeleteTap(e: React.MouseEvent) {
    e.stopPropagation()
    if (!confirming) { setConfirming(true); return }
    onDelete()
  }

  const openX = isOpen ? -SWIPE_WIDTH : 0

  return (
    <div className={[
      'relative rounded-[14px] overflow-hidden bg-surface border border-border transition-opacity',
      item.done ? 'opacity-60' : 'opacity-100',
    ].join(' ')}>
      {/* delete background button */}
      <div
        ref={bgRef}
        onClick={handleDeleteTap}
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

      {/* foreground content (swipe target) */}
      <div
        ref={fgRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={e => e.preventDefault()}
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
          onClick={handleCheckboxTap}
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
          onClick={handleBodyTap}
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

export default memo(PlanningRow, (prev, next) => (
  prev.item === next.item &&
  prev.isPreviewOnly === next.isPreviewOnly &&
  prev.isOpen === next.isOpen
))

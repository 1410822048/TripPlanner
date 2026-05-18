// src/features/trips/components/SwipeableTripItem.tsx
// Trip 列表 row — 左滑刪除 + 長按拖曳重排。
// drag 期間以 ref 直接寫 DOM transform（不走 React state），避免每 pointermove 的重新渲染。
import { useState, useRef, useEffect } from 'react'
import { Trash2, GripVertical } from 'lucide-react'
import { theme as C } from '@/theme'
import { haptic } from '@/utils/haptics'
import type { TripItem } from '@/features/trips/types'
import {
  SWIPE_WIDTH, OPEN_THRESHOLD, MOVE_THRESHOLD,
  FG_TRANSITION, BG_TRANSITION,
} from '@/components/ui/swipeConstants'

export interface SwipeableTripItemProps {
  trip:        TripItem
  isActive:    boolean
  isOpen:      boolean
  canDelete:   boolean
  canReorder:  boolean
  isDragging:  boolean
  dragY:       number
  shiftY:      number
  /** When true, inline trash + grip icons replace the hidden swipe
   *  affordance. Swipe-to-delete is disabled so the user sees only one
   *  way to delete (the visible trash button). Long-press reorder still
   *  works — the grip is a visual hint, not a separate handler. */
  editMode:    boolean
  onSelect:       () => void
  onOpen:         () => void
  onClose:        () => void
  onDelete:       () => void
  onReorderStart: (itemHeight: number) => void
  onReorderMove:  (dy: number) => void
  onReorderEnd:   () => void
}

const LONG_PRESS_MS = 380

function SwipeableTripItem({
  trip, isActive, isOpen, canDelete, canReorder,
  isDragging, dragY, shiftY, editMode,
  onSelect, onOpen, onClose, onDelete,
  onReorderStart, onReorderMove, onReorderEnd,
}: SwipeableTripItemProps) {
  const [confirming, setConfirming] = useState(false)
  const [hover,      setHover]      = useState(false)
  const [pressed,    setPressed]    = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const fgRef   = useRef<HTMLDivElement>(null)
  const bgRef   = useRef<HTMLDivElement>(null)
  const drag = useRef({
    startX: 0, startY: 0,
    currentX: 0,
    dragging: false,
    mode: null as 'swipe' | 'reorder' | null,
    didDrag: false,
    longPressTimer: 0 as number,
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

  // Edge-triggered state resets on prop changes. Each is a simple "when a
  // parent-controlled prop flips, clear a child-local sub-state" — the
  // setState-in-effect purity lint flags this as a cascade, but here the
  // cascade is the goal (one follow-up render) rather than a smell.
  useEffect(() => {
    if (!isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConfirming(false)
    }
  }, [isOpen])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHover(false)
  }, [isActive, isOpen, isDragging])

  useEffect(() => {
    // Capture the ref *object* (stable) — then read its .current at cleanup
    // time so we clear whatever timer is actually pending at unmount,
    // not whatever was pending at mount (which is always 0).
    const dragRef = drag
    return () => { if (dragRef.current.longPressTimer) clearTimeout(dragRef.current.longPressTimer) }
  }, [])

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    function onTouchMoveNative(e: TouchEvent) {
      if (drag.current.mode === 'reorder') e.preventDefault()
    }
    el.addEventListener('touchmove', onTouchMoveNative, { passive: false })
    return () => el.removeEventListener('touchmove', onTouchMoveNative)
  }, [])

  function cancelLongPress() {
    if (drag.current.longPressTimer) {
      clearTimeout(drag.current.longPressTimer)
      drag.current.longPressTimer = 0
    }
    setPressed(false)
  }

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
    catch { /* 某些瀏覽器對 pointer capture 會拋錯 — 可忽略 */ }

    if (!isOpen && canReorder) {
      setPressed(true)
      drag.current.longPressTimer = window.setTimeout(() => {
        if (!drag.current.dragging || drag.current.mode) return
        drag.current.mode = 'reorder'
        drag.current.didDrag = true
        setPressed(false)
        const h = rootRef.current?.getBoundingClientRect().height ?? 55
        onReorderStart(h)
        haptic('light')
      }, LONG_PRESS_MS)
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current.dragging) return
    const dx = e.clientX - drag.current.startX
    const dy = e.clientY - drag.current.startY

    if (drag.current.mode === 'reorder') {
      onReorderMove(dy)
      return
    }

    if (drag.current.mode === 'swipe') {
      drag.current.didDrag = true
      const base = isOpen ? -SWIPE_WIDTH : 0
      const next = Math.min(0, Math.max(-SWIPE_WIDTH, base + dx))
      writeTransform(next)
      return
    }

    if (Math.abs(dx) < MOVE_THRESHOLD && Math.abs(dy) < MOVE_THRESHOLD) return

    cancelLongPress()

    if (Math.abs(dx) > Math.abs(dy)) {
      // In edit mode, the inline trash button replaces swipe-to-delete —
      // swipe is suppressed so the user doesn't see two ways to do the
      // same thing (one visible, one hidden).
      if (canDelete && !editMode) {
        drag.current.mode = 'swipe'
        drag.current.didDrag = true
      } else {
        drag.current.dragging = false
      }
    } else {
      drag.current.dragging = false
      try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) }
      catch { /* no-op */ }
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    cancelLongPress()
    if (!drag.current.dragging) return
    drag.current.dragging = false
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) }
    catch { /* no-op */ }

    const fg = fgRef.current, bg = bgRef.current
    if (fg) fg.style.transition = FG_TRANSITION
    if (bg) bg.style.transition = BG_TRANSITION

    if (drag.current.mode === 'reorder') {
      onReorderEnd()
    } else if (drag.current.mode === 'swipe') {
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

  function handleClick() {
    if (drag.current.didDrag) { drag.current.didDrag = false; return }
    if (isOpen) { onClose(); return }
    onSelect()
  }

  function handleDeleteTap(e: React.MouseEvent) {
    e.stopPropagation()
    if (!confirming) { setConfirming(true); return }
    onDelete()
  }

  const openX = canDelete && isOpen ? -SWIPE_WIDTH : 0

  const outerTransform = isDragging
    ? `translate3d(0,${dragY}px,0) scale(1.04)`
    : shiftY !== 0 ? `translate3d(0,${shiftY}px,0)` : undefined

  const outerTransition = isDragging
    ? 'none'
    : 'transform 0.24s cubic-bezier(0.32,0.72,0,1), box-shadow 0.2s'

  const outerShadow = isDragging
    ? '0 16px 36px rgba(0,0,0,0.20), 0 5px 12px rgba(0,0,0,0.10)'
    : pressed
      ? '0 0 0 2px rgba(107,122,148,0.22)'
      : 'none'

  const innerBg = isActive
    ? C.pickPale
    : (hover && !isOpen && !isDragging ? C.app : C.surface)

  return (
    <div
      ref={rootRef}
      className="relative rounded-xl overflow-hidden mb-px"
      style={{
        transform: outerTransform,
        transition: outerTransition,
        zIndex: isDragging ? 20 : 1,
        boxShadow: outerShadow,
        willChange: isDragging ? 'transform' : undefined,
      }}
    >
      {canDelete && !editMode && (
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
      )}

      <div
        ref={fgRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={handleClick}
        onContextMenu={e => e.preventDefault()}
        onMouseEnter={() => !isDragging && setHover(true)}
        onMouseLeave={() => setHover(false)}
        className="relative select-none"
        style={{
          transform: `translate3d(${openX}px,0,0)`,
          transition: FG_TRANSITION,
          touchAction: isDragging ? 'none' : 'pan-y',
          WebkitTouchCallout: 'none',
          WebkitTapHighlightColor: 'transparent',
          background: innerBg,
          cursor: isDragging ? 'grabbing' : 'pointer',
        }}
      >
        <div className="flex items-center gap-2.5 px-2.5 py-[9px]">
          <div
            className="w-9 h-9 rounded-input shrink-0 flex items-center justify-center text-[17px] pointer-events-none"
            style={{
              background: isActive ? C.pick : C.tile,
              boxShadow: isActive ? `0 2px 8px ${C.pick}44` : 'none',
            }}
          >
            {trip.emoji}
          </div>
          <div className="flex-1 min-w-0 pointer-events-none">
            <div
              className={[
                'text-[13px] -tracking-[0.1px] overflow-hidden text-ellipsis whitespace-nowrap',
                isActive ? 'font-bold text-pick' : 'font-medium text-ink',
              ].join(' ')}
            >
              {trip.title}
            </div>
            <div className="text-[10.5px] text-muted mt-px overflow-hidden text-ellipsis whitespace-nowrap">
              {trip.dest}
            </div>
          </div>
          {isActive && !editMode && (
            <span className="text-[9px] font-bold text-pick bg-pick-pale px-[7px] py-0.5 rounded-card tracking-[0.04em] shrink-0 pointer-events-none">
              進行中
            </span>
          )}
          {editMode && (
            <div className="flex items-center gap-1 shrink-0">
              {canReorder && (
                <span
                  aria-hidden
                  className="text-muted/70 flex items-center justify-center w-7 h-7"
                  title="長押しで並べ替え"
                >
                  <GripVertical size={16} strokeWidth={2} />
                </span>
              )}
              {canDelete && (
                <button
                  type="button"
                  onClick={handleDeleteTap}
                  onPointerDown={e => e.stopPropagation()}
                  aria-label={confirming ? '削除を確定' : `${trip.title}を削除`}
                  className={[
                    'w-7 h-7 rounded-full border-none flex items-center justify-center cursor-pointer transition-colors',
                    confirming ? 'bg-[#A83A3A] text-white' : 'bg-danger-pale text-danger hover:bg-danger-soft',
                  ].join(' ')}
                >
                  <Trash2 size={13} strokeWidth={2.2} />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default SwipeableTripItem

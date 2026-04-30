// src/features/bookings/components/SwipeableBookingItem.tsx
// Mirrors SwipeableExpenseItem — left-swipe to reveal a delete button,
// drag transforms written via ref to skip per-pointermove re-renders.
// Kept as a separate component instead of generalising over <T> because
// the row layout (3-column with a code chip) and the type emoji slot
// differ enough from the expense row that a shared component would need
// render-props for both, which costs more than the duplication.
import { useState, useRef, useEffect, memo } from 'react'
import { Trash2, FileText } from 'lucide-react'
import type { Booking } from '@/types'
import {
  SWIPE_WIDTH, OPEN_THRESHOLD, MOVE_THRESHOLD,
  FG_TRANSITION, BG_TRANSITION,
} from '@/components/ui/swipeConstants'
import { bookingDisplayName, bookingSubtitle } from '../utils'

const TYPE_EMOJI: Record<Booking['type'], string> = {
  flight: '✈️', hotel: '🏨', train: '🚆', bus: '🚌', other: '📌',
}

export interface SwipeableBookingItemProps {
  booking:    Booking
  whenLabel:  string
  isOpen:     boolean
  onSelect:   () => void
  onOpen:     () => void
  onClose:    () => void
  onDelete:   () => void
  /** Tap on the attachment thumbnail/icon — opens the preview modal. */
  onPreview:  () => void
}

function SwipeableBookingItem({
  booking, whenLabel, isOpen, onSelect, onOpen, onClose, onDelete, onPreview,
}: SwipeableBookingItemProps) {
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

  // Reset the "tap once to confirm" gate when the row swipes shut. Same
  // edge-triggered pattern as SwipeableExpenseItem; the lint disable below
  // is documented there.
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

  // Stop propagation so the row's tap-to-edit handler doesn't also fire.
  // Preview button lives inside the foreground swipe layer, so without this
  // a single tap would both open preview and open the edit modal.
  function handlePreviewTap(e: React.MouseEvent) {
    e.stopPropagation()
    onPreview()
  }
  function handlePreviewPointerDown(e: React.PointerEvent) {
    // Block the swipe gesture from arming; the parent's pointerdown/move
    // handlers run on the row, and we don't want a tap on the thumbnail to
    // be misread as a swipe start.
    e.stopPropagation()
  }

  const openX = isOpen ? -SWIPE_WIDTH : 0
  const isImageAttachment = (booking.fileType ?? '').startsWith('image/')

  return (
    <div className="relative rounded-[18px] overflow-hidden bg-surface border border-border shadow-[0_2px_10px_rgba(0,0,0,0.05)]">
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

      {/* foreground content */}
      <div
        ref={fgRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={handleClick}
        onContextMenu={e => e.preventDefault()}
        className="relative select-none cursor-pointer bg-surface"
        style={{
          transform: `translate3d(${openX}px,0,0)`,
          transition: FG_TRANSITION,
          touchAction: 'pan-y',
          WebkitTouchCallout: 'none',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <div className="flex items-center gap-3 px-3 py-2.5">
          {/* Leading slot — image thumbnail for image attachments (more
              informative than the category emoji, which is already shown
              in the section header) or category emoji otherwise. The
              image branch is delegated to a separate component so the
              imgError state can reset whenever the URL changes (via
              `key`); inlining setState here would either leak stale
              error state across replacements or force a setState-in-
              effect to reset it. */}
          <ThumbnailSlot
            key={booking.fileUrl ?? booking.type}
            booking={booking}
            onPreviewTap={handlePreviewTap}
            onPreviewPointerDown={handlePreviewPointerDown}
          />
          <div className="flex-1 min-w-0 pointer-events-none">
            {/* Transport bookings: primary line is the route ({origin} → {destination}).
                Non-transport: primary line is the title. The subtitle then
                mixes vehicle name (if transport) + provider + when. */}
            <div className="text-[13.5px] font-bold text-ink truncate">
              {bookingDisplayName(booking)}
            </div>
            <Subtitle booking={booking} whenLabel={whenLabel} />
          </div>
          {/* Right-side preview button only shows for non-image attachments
              (PDFs). Image attachments use the leading thumbnail as the
              preview tap target. */}
          {booking.fileUrl && !isImageAttachment && (
            <button
              type="button"
              onClick={handlePreviewTap}
              onPointerDown={handlePreviewPointerDown}
              aria-label="添付を表示"
              className="shrink-0 w-9 h-9 rounded-md flex items-center justify-center bg-app text-muted border-none cursor-pointer hover:bg-tile transition-colors"
            >
              <FileText size={14} strokeWidth={1.8} className="pointer-events-none" />
            </button>
          )}
          {booking.confirmationCode && (
            <div className="shrink-0 px-2 py-1 rounded-md bg-app text-[10px] font-mono font-semibold text-muted tracking-tight tabular-nums max-w-[88px] truncate pointer-events-none">
              {booking.confirmationCode}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Leading 48×48 slot. Falls back to the category emoji when:
 *   - no attachment, or attachment is not an image (e.g. PDF), or
 *   - the image failed to load (broken URL, network blip, etc.)
 *
 * Prefers the 192px `thumbUrl` over the full-size `fileUrl` to keep the
 * list under 100KB total instead of multi-MB. Older bookings created
 * before thumb generation existed don't have thumbUrl — those fall back
 * to fileUrl, which still works (just slower).
 *
 * `loading="lazy"` is intentionally omitted: iOS Safari has a long-
 * standing bug where the IntersectionObserver-based lazy loader fails
 * inside a non-document scroll container (our AppLayout's <main> with
 * `overflow:auto`), causing the image to never request and the slot to
 * appear permanently empty. `decoding="async"` is the safer fallback —
 * keeps decode off the main thread without involving the observer.
 */
function ThumbnailSlot({
  booking, onPreviewTap, onPreviewPointerDown,
}: {
  booking:              Booking
  onPreviewTap:         (e: React.MouseEvent) => void
  onPreviewPointerDown: (e: React.PointerEvent) => void
}) {
  const [imgError, setImgError] = useState(false)
  const isImageAttachment = (booking.fileType ?? '').startsWith('image/')
  const thumbSrc = booking.thumbUrl ?? booking.fileUrl
  const showImage = isImageAttachment && thumbSrc && !imgError

  if (!showImage) {
    return (
      <div className="w-12 h-12 rounded-xl shrink-0 flex items-center justify-center text-[22px] bg-tile border border-black/5 pointer-events-none">
        {TYPE_EMOJI[booking.type]}
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={onPreviewTap}
      onPointerDown={onPreviewPointerDown}
      aria-label="添付を表示"
      className="w-12 h-12 rounded-xl shrink-0 overflow-hidden border border-black/5 bg-tile cursor-pointer p-0 hover:opacity-85 transition-opacity"
    >
      <img
        src={thumbSrc}
        alt=""
        decoding="async"
        onError={() => setImgError(true)}
        className="w-full h-full object-cover pointer-events-none"
        draggable={false}
      />
    </button>
  )
}

/** Renders the row's small grey meta line; suppressed entirely when nothing
 *  meaningful would show, so the title sits visually centred in the row. */
function Subtitle({ booking, whenLabel }: { booking: Booking; whenLabel: string }) {
  const sub = bookingSubtitle(booking)
  const hasAny = sub.length > 0 || whenLabel.length > 0
  if (!hasAny) return null
  return (
    <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-muted truncate">
      {sub && <span className="truncate">{sub}</span>}
      {sub && whenLabel && <span className="text-border">·</span>}
      {whenLabel && <span className="truncate tabular-nums">{whenLabel}</span>}
    </div>
  )
}

export default memo(SwipeableBookingItem, (prev, next) => (
  prev.booking === next.booking &&
  prev.whenLabel === next.whenLabel &&
  prev.isOpen === next.isOpen
))

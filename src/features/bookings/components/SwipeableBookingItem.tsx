// src/features/bookings/components/SwipeableBookingItem.tsx
// Swipeable shell + dispatcher for the booking row. The shell owns the
// pointer-driven swipe gesture, the red delete background, and the tap
// that routes to edit. The visual content itself is delegated to a
// per-type sub-card under `./cards/`:
//
//   flight → FlightCard  (boarding-pass layout)
//   hotel  → HotelCard   (reservation card with cover image)
//   train  → TrainCard   (ticket band + route)
//   bus / other → GenericCard (compact row, prior look — also owns
//                              its own PDF-preview button so the
//                              dispatcher stays type-agnostic)
//
// Swipe affordance is permission-gated by the caller: when delete
// permission isn't available (viewer role), the swipe props +
// onDelete are omitted and we render a plain non-swipeable card.
// Tap-to-edit still works in that branch — viewers can read details.
//
// Why dispatch instead of one big component: each type has very
// different information density (flight has flight#/conf/seats; hotel
// has check-in/out/cover; train has route/vehicle), and trying to
// express all four in one render tree was the "single boring row for
// everything" UX we eliminated.
import { memo } from 'react'
import { Trash2 } from 'lucide-react'
import type { Booking } from '@/types'
import { useSwipeRow, SWIPE_WIDTH, BG_TRANSITION, FG_TRANSITION } from '@/hooks/useSwipeRow'
import FlightCard  from './cards/FlightCard'
import HotelCard   from './cards/HotelCard'
import TrainCard   from './cards/TrainCard'
import GenericCard from './cards/GenericCard'

export interface SwipeableBookingItemProps {
  booking:    Booking
  whenLabel:  string
  onSelect:   () => void
  /** Tap on the attachment thumbnail/PDF icon — opens the preview modal. */
  onPreview:  () => void
  /** Swipe-state controlled by parent (useSwipeOpen). Optional — when
   *  any of these are absent the row renders without swipe affordance
   *  (used for viewers without delete permission). */
  isOpen?:    boolean
  onOpen?:    () => void
  onClose?:   () => void
  onDelete?:  () => void
}

function SwipeableBookingItem({
  booking, whenLabel, onSelect, onPreview,
  isOpen, onOpen, onClose, onDelete,
}: SwipeableBookingItemProps) {
  const swipeable = !!onDelete && !!onOpen && !!onClose
  const {
    bindFg, bindBg, pointerProps, deleteProps, openX, confirming, wrapTap,
  } = useSwipeRow({ isOpen: !!isOpen, onOpen, onClose, onDelete, enabled: swipeable })

  // Dispatch table — keeps the render tree flat and lets TypeScript
  // narrow each card's prop shape at the case site.
  function renderBody() {
    switch (booking.type) {
      case 'flight': return <FlightCard booking={booking} />
      case 'hotel':  return <HotelCard  booking={booking} />
      case 'train':  return <TrainCard  booking={booking} />
      default:       return <GenericCard booking={booking} whenLabel={whenLabel} onPreview={onPreview} />
    }
  }

  // Non-swipeable branch: viewers without delete permission get a
  // plain tap-to-edit card. Pointer handlers omitted entirely so
  // there's no chance of a half-armed gesture.
  if (!swipeable) {
    return (
      <div
        onClick={onSelect}
        className="relative rounded-[18px] overflow-hidden bg-surface border border-border shadow-[0_2px_10px_rgba(0,0,0,0.05)] cursor-pointer select-none"
      >
        {renderBody()}
      </div>
    )
  }

  return (
    <div className="relative rounded-[18px] overflow-hidden bg-surface border border-border shadow-[0_2px_10px_rgba(0,0,0,0.05)]">
      {/* delete background (revealed by left-swipe) */}
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

      {/* foreground (sliding) — owns the pointer gesture + click → edit. */}
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
        {renderBody()}
      </div>
    </div>
  )
}

export default memo(SwipeableBookingItem, (prev, next) => (
  prev.booking === next.booking &&
  prev.whenLabel === next.whenLabel &&
  prev.isOpen === next.isOpen
))

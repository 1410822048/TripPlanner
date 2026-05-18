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
// Permission gates are caller-driven:
//   - Swipe + delete: omit swipe props + onDelete → no swipe affordance.
//   - Edit (card tap): omit onSelect → no cursor / no click. Viewers
//     can still read everything visible on the card; the edit modal
//     wouldn't show new info, and saving was blocked by firestore.rules
//     anyway, which produced the "open edit, hit save, get error" UX.
//
// Why dispatch instead of one big component: each type has very
// different information density (flight has flight#/conf/seats; hotel
// has check-in/out/cover; train has route/vehicle), and trying to
// express all four in one render tree was the "single boring row for
// everything" UX we eliminated.
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
  /** Tap on the card body — opens the edit modal. Optional: viewers
   *  (no write permission) omit it; the card then has no cursor/click. */
  onSelect?:  () => void
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

  // Non-swipeable branch: pointer handlers omitted entirely so there's
  // no chance of a half-armed gesture. Tap behaviour follows onSelect:
  // present (editor / owner / demo) → cursor-pointer + click opens
  // edit modal. Absent (viewer) → read-only surface.
  if (!swipeable) {
    return (
      <div
        onClick={onSelect}
        className={[
          'relative rounded-[18px] overflow-hidden bg-surface border border-border shadow-[0_2px_10px_rgba(0,0,0,0.05)] select-none',
          onSelect ? 'cursor-pointer' : '',
        ].join(' ')}
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

      {/* foreground (sliding) — pointer gesture always; click → edit
          only when onSelect supplied. In current code paths, having
          swipe+delete (canWrite path) always implies onSelect too,
          but the conditional keeps the contract honest. */}
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
        {renderBody()}
      </div>
    </div>
  )
}

export default SwipeableBookingItem

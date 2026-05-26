// src/features/bookings/components/SwipeableBookingItem.tsx
// Swipeable shell + dispatcher for the booking row. The shell
// (SwipeableShell) owns the pointer-driven swipe gesture, the red
// delete background, and the tap that routes to edit. The visual
// content itself is delegated to a per-type sub-card under `./cards/`:
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
import { Loader2 } from 'lucide-react'
import type { Booking } from '@/types'
import SwipeableShell from '@/components/ui/SwipeableShell'
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
  // Rows added via optimistic update carry a `temp-` id until the
  // Firestore + Storage round-trip lands. While pending, disable
  // tap/swipe and dim the body + show a 保存中… pill so the user
  // knows the row is still saving. Mirrors SwipeableExpenseItem.
  const isPending = booking.id.startsWith('temp-')

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

  return (
    <SwipeableShell
      className="rounded-[18px] border border-border shadow-[0_2px_10px_rgba(0,0,0,0.05)]"
      onSelect={onSelect}
      isOpen={isOpen}
      onOpen={onOpen}
      onClose={onClose}
      onDelete={onDelete}
      disabled={isPending}
    >
      <div className={['relative transition-opacity', isPending ? 'opacity-55' : ''].join(' ')}>
        {renderBody()}
        {isPending && (
          <div className="absolute top-2 right-2 flex items-center gap-1 px-2 py-0.5 rounded-full bg-black/60 text-white text-[10.5px] font-semibold backdrop-blur-sm">
            <Loader2 size={11} strokeWidth={2.4} className="animate-spin" />
            <span>保存中…</span>
          </div>
        )}
      </div>
    </SwipeableShell>
  )
}

export default SwipeableBookingItem

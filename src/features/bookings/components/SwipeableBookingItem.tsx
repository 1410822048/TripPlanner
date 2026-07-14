// src/features/bookings/components/SwipeableBookingItem.tsx
// Swipeable shell + dispatcher for the booking row. The shell
// (SwipeableShell) owns the pointer-driven swipe gesture, the red
// delete background, and the tap that routes to read-only detail. The visual
// content itself is delegated to BookingPassCard so the list and detail
// surfaces share one wallet-pass information model.
//
// Permission gates are caller-driven:
//   - Swipe + delete: omit swipe props + onDelete → no swipe affordance.
//   - Detail (card tap): pass onSelect for every role. Edit is exposed
//     by the read-only detail sheet only when the caller has write permission.
//
import { Loader2 } from 'lucide-react'
import type { Booking } from '@/types'
import SwipeableShell from '@/components/ui/SwipeableShell'
import BookingPassCard from './BookingPassCard'
import { bookingDisplayName } from '../utils'

interface SwipeableBookingItemProps {
  booking:    Booking
  whenLabel:  string
  /** Tap on the card body — opens the read-only detail surface. */
  onSelect?:  () => void
  /** True when this row's UPDATE mutation is in-flight. Pages derive
   *  the set via `usePendingMutationIds`. CREATE pending is detected
   *  via the `temp-` id prefix; UPDATE preserves the real id and needs
   *  this signal to surface the same 保存中… visual. */
  isUpdating?: boolean
  /** Swipe-state controlled by parent (useSwipeOpen). Optional — when
   *  any of these are absent the row renders without swipe affordance
   *  (used for viewers without delete permission). */
  isOpen?:    boolean
  onOpen?:    () => void
  onClose?:   () => void
  onDelete?:  () => void
}

function SwipeableBookingItem({
  booking, whenLabel, onSelect,
  isOpen, isUpdating, onOpen, onClose, onDelete,
}: SwipeableBookingItemProps) {
  // CREATE pending → `temp-` id prefix. UPDATE preserves the real id,
  // so the page also passes `isUpdating` (derived from `useMutationState`).
  // Either signal disables tap/swipe + dims the body + shows the
  // 保存中… pill. Mirrors SwipeableExpenseItem.
  const isPending = booking.id.startsWith('temp-') || !!isUpdating

  function renderBody() {
    return <BookingPassCard booking={booking} whenLabel={whenLabel} />
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
      {({ clickable, selectButtonProps }) => (
        <div className={['relative transition-opacity', isPending ? 'opacity-55' : ''].join(' ')}>
          {clickable ? (
            <button
              {...selectButtonProps}
              aria-label={`顯示 ${bookingDisplayName(booking)} 的詳細資料`}
              className="block w-full p-0 border-none bg-transparent text-left text-inherit cursor-pointer disabled:cursor-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {renderBody()}
            </button>
          ) : (
            renderBody()
          )}
          {isPending && (
            <div className="absolute top-2 right-2 flex items-center gap-1 px-2 py-0.5 rounded-full bg-black/60 text-white text-[10.5px] font-semibold backdrop-blur-sm">
              <Loader2 size={11} strokeWidth={2.4} className="animate-spin" />
              <span>儲存中…</span>
            </div>
          )}
        </div>
        )}
    </SwipeableShell>
  )
}

export default SwipeableBookingItem

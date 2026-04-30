// src/hooks/useSwipeOpen.ts
// Manages "which row in this list is currently swiped open?" state for
// swipe-to-delete patterns (BookingsPage, ExpensePage, PlanningPage,
// TripSwitcher). Each call site previously inlined:
//
//   const [swipedId, setSwipedId] = useState<string | null>(null)
//   ...
//   isOpen={swipedId === item.id}
//   onOpen={() => setSwipedId(item.id)}
//   onClose={() => { if (swipedId === item.id) setSwipedId(null) }}
//   // wrapper div: onClick={() => setSwipedId(null)}
//   // and wrap row onSelect with setSwipedId(null) before primary action
//
// A bug discovered late: the close-on-other-row-tap and close-on-outside-
// tap behaviours were missing in some places (we patched them across 4
// pages). Centralising in a hook prevents the next swipeable list from
// repeating the omission.
import { useCallback, useState } from 'react'

interface RowBindings {
  /** True when this row is the currently-swiped one. */
  isOpen:  boolean
  /** Latch this row open (called by the row's gesture handler). */
  onOpen:  () => void
  /** Close this row (no-op if a different row is currently open — guard
   *  against a stale onClose latching us to null after another row took
   *  over the open slot). */
  onClose: () => void
}

export interface UseSwipeOpenResult<TId extends string = string> {
  swipedId: TId | null
  /** Returns the three props (`isOpen`, `onOpen`, `onClose`) for a single
   *  row. Spread onto the swipeable component:
   *    `<SwipeableItem {...swipe.bindRow(item.id)} ... />` */
  bindRow:  (id: TId) => RowBindings
  /** Close any currently-open swipe. Attach to the page wrapper's onClick
   *  AND wrap row primary actions (onSelect / onTap) so that tapping a
   *  different row dismisses the open one. */
  closeAll: () => void
}

export function useSwipeOpen<TId extends string = string>(): UseSwipeOpenResult<TId> {
  const [swipedId, setSwipedId] = useState<TId | null>(null)

  const closeAll = useCallback(() => setSwipedId(null), [])

  const bindRow = useCallback((id: TId): RowBindings => ({
    isOpen:  swipedId === id,
    onOpen:  () => setSwipedId(id),
    onClose: () => setSwipedId(prev => prev === id ? null : prev),
  }), [swipedId])

  return { swipedId, bindRow, closeAll }
}

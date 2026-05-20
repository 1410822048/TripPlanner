import type { Timestamp } from 'firebase/firestore'

// Placeholder used by mock fixtures when Firebase is not connected.
// Shape-compatible enough to satisfy `TimestampSchema` (duck-types `toDate`)
// and any consumer that needs `.toMillis()` — so accidentally routing mock
// data through a Firestore read path no longer throws.
export const MOCK_TIMESTAMP: Timestamp = {
  toDate:   () => new Date(0),
  toMillis: () => 0,
  seconds:     0,
  nanoseconds: 0,
  isEqual:  (other: Timestamp) => other === MOCK_TIMESTAMP,
  toJSON:   () => ({ seconds: 0, nanoseconds: 0, type: 'firestore/timestamp/1.0' }),
  valueOf:  () => '000000000000.000000000',
} as unknown as Timestamp

/**
 * Timestamp shaped like `MOCK_TIMESTAMP` but anchored at `Date.now()`.
 * Used by optimistic delete patches so the tombstone's `toMillis()`
 * sorts AFTER real-server timestamps in chronological replays. The
 * fixed-epoch MOCK_TIMESTAMP (toMillis=0) would otherwise push the
 * optimistic delete event to position 0 in the event timeline,
 * making `buildOrphanReasonMap` misclassify orphans during the brief
 * window between the optimistic UI update and the realtime listener
 * reconciling to the server timestamp.
 */
export function mockTimestampNow(): Timestamp {
  const ms = Date.now()
  return {
    toDate:   () => new Date(ms),
    toMillis: () => ms,
    seconds:     Math.floor(ms / 1000),
    nanoseconds: (ms % 1000) * 1_000_000,
    isEqual:  (other: Timestamp) => other?.toMillis?.() === ms,
    toJSON:   () => ({ seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1_000_000, type: 'firestore/timestamp/1.0' }),
    valueOf:  () => String(ms).padStart(12, '0') + '.000000000',
  } as unknown as Timestamp
}

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

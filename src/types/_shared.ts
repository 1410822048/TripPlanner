// src/types/_shared.ts
// Cross-entity zod helpers. Importing from `_shared` (underscore prefix
// keeps it visually distinct from entity files like `trip.ts` /
// `booking.ts`) makes it clear at a glance that this isn't a domain
// type — it's plumbing.
import { z } from 'zod'
import type { Timestamp } from 'firebase/firestore'

/**
 * Duck-type Firestore Timestamp validator. We don't `instanceof Timestamp`
 * because that would force a runtime import of the firebase/firestore
 * class — defeating the lazy-loading dance we do in services/firebase.ts.
 * The shape check (object with toDate fn) is sufficient: real Timestamps
 * pass; mock fixtures (mocks/utils.MOCK_TIMESTAMP) also pass; anything
 * else fails parsing.
 */
export const TimestampSchema = z.custom<Timestamp>(
  v => v != null && typeof v === 'object' && typeof (v as { toDate?: unknown }).toDate === 'function',
  { message: 'Expected Firestore Timestamp' },
)

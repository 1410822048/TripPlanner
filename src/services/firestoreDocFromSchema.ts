// src/services/firestoreDocFromSchema.ts
// Generic Zod-validated read for Firestore docs. Replaces the
// `*FromDoc` helper that booking / expense / schedule / wish /
// planning / member services each defined as a near-clone:
//
//   function bookingFromDoc(d: QueryDocumentSnapshot): Booking {
//     const parsed = BookingDocSchema.safeParse(d.data())
//     if (!parsed.success) {
//       captureError(parsed.error, { source: 'bookingFromDoc', docId: d.id })
//       throw new Error(`Booking ${d.id} failed schema validation`)
//     }
//     return { id: d.id, ...parsed.data } as Booking
//   }
//
// The pattern's three jobs — narrow at the trust boundary, surface
// production data corruption to Sentry, fail loudly so the route-level
// ErrorBoundary can recover — were too valuable to skip but too tedious
// to keep typing. One helper, six callers, one place to evolve later
// (e.g. swap Sentry for OTel, or attach more diagnostic context).
//
// On parse failure: throws. Callers that want "skip the bad doc"
// semantics (see `getTripsByIds` in tripService) keep their inline
// flatMap — rare enough to not warrant a second helper.
import type { QueryDocumentSnapshot } from 'firebase/firestore'
import type { z } from 'zod'
import { captureError } from './sentry'

// Constrained to object schemas. Caller guarantees the schema describes
// an object — anything else can't be merged with `{ id }` anyway.
export function firestoreDocFromSchema<T extends z.ZodObject<z.ZodRawShape>>(
  schema: T,
  doc:    QueryDocumentSnapshot,
  source: string,
): { id: string } & z.infer<T> {
  const parsed = schema.safeParse(doc.data())
  if (!parsed.success) {
    captureError(parsed.error, { source, docId: doc.id })
    throw new Error(`Doc ${doc.id} (${source}) failed schema validation`)
  }
  return { id: doc.id, ...parsed.data } as { id: string } & z.infer<T>
}

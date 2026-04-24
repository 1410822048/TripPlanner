// src/features/bookings/services/bookingService.ts
// Thin wrapper over /trips/{tripId}/bookings — the full bookings feature is
// still a placeholder, but this service is already schema-validated so when
// the create/edit flow lands, downstream code (like PastLodgingPage) trusts
// the shape without re-checking.
import type { QueryDocumentSnapshot } from 'firebase/firestore'
import { getFirebase } from '@/services/firebase'
import { P } from '@/services/paths'
import { BookingDocSchema, type Booking } from '@/types'

function bookingFromDoc(d: QueryDocumentSnapshot): Booking | null {
  const parsed = BookingDocSchema.safeParse(d.data())
  if (!parsed.success) {
    console.error(`[bookingService] invalid booking doc ${d.id}:`, parsed.error.issues)
    return null
  }
  return { id: d.id, ...parsed.data } as Booking
}

/** Fetch all hotel-type bookings for a single trip. */
export async function getHotelBookingsByTrip(tripId: string): Promise<Booking[]> {
  const { db, collection, query, where, getDocs } = await getFirebase()
  const q = query(
    collection(db, ...P.bookings(tripId)),
    where('type', '==', 'hotel'),
  )
  const snap = await getDocs(q)
  return snap.docs
    .map(bookingFromDoc)
    .filter((b): b is Booking => b !== null)
}

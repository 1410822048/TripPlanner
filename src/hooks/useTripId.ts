// src/hooks/useTripId.ts
// Active CLOUD trip id without threading it through props. Mirrors
// useTripCurrency's source (useTripContext) but returns null outside the
// cloud status — callers use it for Worker routes that need a REAL Firestore
// trip (e.g. /expense-receipt-ocr re-OCR), which don't apply in demo /
// loading / no-trip. A null result means "this cloud-only action is
// unavailable here", letting the caller fall back gracefully.
import { useTripContext } from './useTripContext'

export function useTripId(): string | null {
  const ctx = useTripContext()
  return ctx.status === 'cloud' ? ctx.trip.id : null
}

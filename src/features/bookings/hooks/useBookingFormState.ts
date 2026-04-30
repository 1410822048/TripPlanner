// src/features/bookings/hooks/useBookingFormState.ts
// Booking-specific bindings around the generic useFormReducer hook —
// owns the field shape + initial-state derivation from an edit target.
// Keep this file thin; the generic mutation logic lives in
// `@/hooks/useFormReducer`.
import { useFormReducer, type UseFormReducerResult } from '@/hooks/useFormReducer'
import type { Booking } from '@/types'

// `type` (not `interface`): TS won't widen interfaces to satisfy
// `Record<string, unknown>` since interfaces are open for declaration
// merging. Type aliases are closed and pass useFormReducer's constraint.
export type BookingFormState = {
  type:             Booking['type']
  title:            string
  origin:           string
  destination:      string
  confirmationCode: string
  provider:         string
  checkIn:          string
  checkOut:         string
  note:             string
}

/** `checkIn` may be ISO datetime ('2026-05-01T07:30') or date-only.
 *  The DatePicker only handles 'YYYY-MM-DD', so trim the time portion. */
function toDateOnly(s: string | undefined): string {
  if (!s) return ''
  return s.slice(0, 10)
}

function initFromBooking(b: Booking | null): BookingFormState {
  return {
    type:             b?.type ?? 'flight',
    title:            b?.title ?? '',
    origin:           b?.origin ?? '',
    destination:      b?.destination ?? '',
    confirmationCode: b?.confirmationCode ?? '',
    provider:         b?.provider ?? '',
    checkIn:          toDateOnly(b?.checkIn),
    checkOut:         toDateOnly(b?.checkOut),
    note:             b?.note ?? '',
  }
}

export type UseBookingFormStateResult = UseFormReducerResult<BookingFormState>

export function useBookingFormState(editTarget: Booking | null): UseBookingFormStateResult {
  return useFormReducer<BookingFormState>(() => initFromBooking(editTarget))
}

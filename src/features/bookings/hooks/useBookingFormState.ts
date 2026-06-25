// src/features/bookings/hooks/useBookingFormState.ts
// Booking-specific bindings around the generic useFormReducer hook —
// owns the field shape + initial-state derivation from an edit target.
// Keep this file thin; the generic mutation logic lives in
// `@/hooks/useFormReducer`.
import { useFormReducer, type UseFormReducerResult } from '@/hooks/useFormReducer'
import type { Booking } from '@/types'
import { initBookingFormState, type BookingFormDraft, type BookingFormState } from '../bookingFormState'

export type { BookingFormDraft, BookingFormState } from '../bookingFormState'

export type UseBookingFormStateResult = UseFormReducerResult<BookingFormState>

export function useBookingFormState(
  editTarget:    Booking | null,
  initialDraft?: BookingFormDraft,
): UseBookingFormStateResult {
  return useFormReducer<BookingFormState>(() => initBookingFormState(editTarget, initialDraft))
}

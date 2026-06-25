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
  address:          string
  link:             string
  note:             string
}

export type BookingFormDraft = Partial<BookingFormState>

/** `checkIn` may be ISO datetime ('2026-05-01T07:30') or date-only.
 *  The DatePicker only handles 'YYYY-MM-DD', so trim the time portion. */
function toDateOnly(s: string | undefined): string {
  if (!s) return ''
  return s.slice(0, 10)
}

export function initBookingFormState(
  b:             Booking | null,
  initialDraft?: BookingFormDraft,
): BookingFormState {
  const base = {
    type:             b?.type ?? 'flight',
    title:            b?.title ?? '',
    origin:           b?.origin ?? '',
    destination:      b?.destination ?? '',
    confirmationCode: b?.confirmationCode ?? '',
    provider:         b?.provider ?? '',
    checkIn:          toDateOnly(b?.checkIn),
    checkOut:         toDateOnly(b?.checkOut),
    address:          b?.address ?? '',
    link:             b?.link ?? '',
    note:             b?.note ?? '',
  }
  return b ? base : { ...base, ...initialDraft }
}

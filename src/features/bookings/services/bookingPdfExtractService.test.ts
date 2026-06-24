import { describe, expect, it } from 'vitest'
import type { BookingFormState } from '../hooks/useBookingFormState'
import {
  bookingPdfExtractToDraftPatch,
  type BookingPdfExtractResult,
} from './bookingPdfExtractService'

function state(over: Partial<BookingFormState> = {}): BookingFormState {
  return {
    type:             'flight',
    title:            '',
    origin:           '',
    destination:      '',
    confirmationCode: '',
    provider:         '',
    checkIn:          '',
    checkOut:         '',
    address:          '',
    link:             '',
    note:             '',
    ...over,
  }
}

function field(value: string, confidence = 0.9, evidence = value) {
  return { value, confidence, evidence }
}

function result(over: Partial<BookingPdfExtractResult> = {}): BookingPdfExtractResult {
  return {
    bookingType:      'hotel',
    title:            field('Hotel Sakura'),
    provider:         field('Booking.com'),
    confirmationCode: field('ABC123'),
    checkIn:          field('2026-07-01'),
    checkOut:         field('2026-07-03'),
    address:          field('東京都台東区浅草1-1-1'),
    link:             field('https://example.com/reservation'),
    warnings:         [],
    ...over,
  }
}

describe('bookingPdfExtractToDraftPatch', () => {
  it('prefills blank create forms and flips the default flight type to hotel', () => {
    expect(bookingPdfExtractToDraftPatch(state(), result(), { isEdit: false })).toEqual({
      appliedCount: 8,
      patch: {
        type:             'hotel',
        title:            'Hotel Sakura',
        provider:         'Booking.com',
        confirmationCode: 'ABC123',
        checkIn:          '2026-07-01',
        checkOut:         '2026-07-03',
        address:          '東京都台東区浅草1-1-1',
        link:             'https://example.com/reservation',
      },
    })
  })

  it('does not overwrite fields the user already typed while extraction was running', () => {
    const out = bookingPdfExtractToDraftPatch(
      state({
        type:             'hotel',
        title:            'Manual hotel',
        provider:         'Manual provider',
        confirmationCode: 'MANUAL',
      }),
      result(),
      { isEdit: false },
    )

    expect(out.patch).not.toMatchObject({
      title:            'Hotel Sakura',
      provider:         'Booking.com',
      confirmationCode: 'ABC123',
    })
    expect(out.patch).toMatchObject({
      checkIn:  '2026-07-01',
      checkOut: '2026-07-03',
      address:  '東京都台東区浅草1-1-1',
    })
  })

  it('does not overwrite a manually selected non-default type', () => {
    const out = bookingPdfExtractToDraftPatch(
      state({ type: 'other' }),
      result(),
      { isEdit: false },
    )

    expect(out.patch.type).toBeUndefined()
  })

  it('requires high-confidence address evidence and ignores invalid links', () => {
    const out = bookingPdfExtractToDraftPatch(
      state(),
      result({
        address: field('Directions from the station', 0.7),
        link:    field('javascript:alert(1)', 0.99),
      }),
      { isEdit: false },
    )

    expect(out.patch.address).toBeUndefined()
    expect(out.patch.link).toBeUndefined()
  })
})

// Display helpers used by every booking renderer. These were touched in
// the A3 attachment-nested refactor, so the tests primarily defend
// against thumb-vs-file fallback regressions and the transport-vs-other
// branching in display name / subtitle.
import { describe, expect, test } from 'vitest'
import {
  attachmentThumb,
  isImageAttachment,
  bookingDisplayName,
  bookingSubtitle,
} from './utils'
import type { Booking, BookingAttachment } from '@/types'

function makeAtt(over: Partial<BookingAttachment>): BookingAttachment {
  return {
    fileUrl:  'https://example.com/file.webp',
    filePath: 'trips/t/bookings/b/file.webp',
    fileType: 'image/webp',
    ...over,
  }
}

function makeBooking(over: Partial<Booking>): Booking {
  // Minimal type-correct skeleton; tests only touch the fields the helpers read.
  return {
    id:        'b1',
    tripId:    't1',
    type:      'flight',
    memberIds: ['u1'],
    createdBy: 'u1',
    updatedBy: 'u1',
    createdAt: { toMillis: () => 0 } as Booking['createdAt'],
    updatedAt: { toMillis: () => 0 } as Booking['updatedAt'],
    ...over,
  }
}

describe('attachmentThumb', () => {
  test('prefers thumbUrl when present', () => {
    expect(attachmentThumb(makeAtt({ thumbUrl: 'https://x/t.webp' })))
      .toBe('https://x/t.webp')
  })

  test('falls back to fileUrl when no thumb', () => {
    expect(attachmentThumb(makeAtt({})))
      .toBe('https://example.com/file.webp')
  })

  test('undefined attachment returns undefined', () => {
    expect(attachmentThumb(undefined)).toBeUndefined()
  })
})

describe('isImageAttachment', () => {
  test('true for image/* mime types', () => {
    expect(isImageAttachment(makeAtt({ fileType: 'image/webp' }))).toBe(true)
    expect(isImageAttachment(makeAtt({ fileType: 'image/jpeg' }))).toBe(true)
    expect(isImageAttachment(makeAtt({ fileType: 'image/heic' }))).toBe(true)
  })

  test('false for non-image (PDF)', () => {
    expect(isImageAttachment(makeAtt({ fileType: 'application/pdf' }))).toBe(false)
  })

  test('false when no attachment', () => {
    expect(isImageAttachment(undefined)).toBe(false)
  })
})

describe('bookingDisplayName', () => {
  test('transport with both endpoints renders arrow', () => {
    const b = makeBooking({ type: 'flight', origin: 'NRT', destination: 'TPE' })
    expect(bookingDisplayName(b)).toBe('NRT → TPE')
  })

  test('falls back to title when route is incomplete', () => {
    const b = makeBooking({ type: 'flight', origin: 'NRT', title: 'NH102' })
    expect(bookingDisplayName(b)).toBe('NH102')
  })

  test('hotel uses title directly', () => {
    const b = makeBooking({ type: 'hotel', title: 'Marriott Tokyo' })
    expect(bookingDisplayName(b)).toBe('Marriott Tokyo')
  })

  test('falls back to generic word when nothing is set', () => {
    const b = makeBooking({ type: 'other' })
    expect(bookingDisplayName(b)).toBe('予約')
  })
})

describe('bookingSubtitle', () => {
  test('transport: vehicle name + provider joined with middle dot', () => {
    const b = makeBooking({ type: 'flight', title: 'NH102', provider: 'ANA' })
    expect(bookingSubtitle(b)).toBe('NH102 · ANA')
  })

  test('non-transport skips title (title is already the header)', () => {
    const b = makeBooking({ type: 'hotel', title: 'Marriott', provider: 'Booking.com' })
    expect(bookingSubtitle(b)).toBe('Booking.com')
  })

  test('returns empty when neither title nor provider is set', () => {
    const b = makeBooking({ type: 'flight' })
    expect(bookingSubtitle(b)).toBe('')
  })

  test('provider-only flight (no flight number) still renders', () => {
    const b = makeBooking({ type: 'flight', provider: 'ANA' })
    expect(bookingSubtitle(b)).toBe('ANA')
  })
})

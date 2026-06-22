// Display helpers used by every booking renderer. These were touched in
// the A3 attachment-nested refactor, so the tests primarily defend
// against thumb-vs-file fallback regressions and the transport-vs-other
// branching in display name / subtitle.
import { describe, expect, test } from 'vitest'
import {
  attachmentThumbPath,
  bookingProviderFromUrl,
  isImageAttachment,
  bookingDisplayName,
  bookingSubtitle,
} from './utils'
import type { Booking, BookingAttachment } from '@/types'

function makeAtt(over: Partial<BookingAttachment>): BookingAttachment {
  return {
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

describe('bookingProviderFromUrl', () => {
  test('extracts a normalized provider hostname from http(s) URLs', () => {
    expect(bookingProviderFromUrl('https://www.booking.com/hotel/jp/abc.html')).toBe('booking.com')
    expect(bookingProviderFromUrl('http://trip.com/orders/123')).toBe('trip.com')
  })

  test('returns empty for invalid or empty values', () => {
    expect(bookingProviderFromUrl('')).toBe('')
    expect(bookingProviderFromUrl('not a url')).toBe('')
  })
})

describe('attachmentThumbPath', () => {
  test('returns thumbPath when present', () => {
    expect(attachmentThumbPath(makeAtt({ thumbPath: 'trips/t/bookings/b/file.thumb.webp' })))
      .toBe('trips/t/bookings/b/file.thumb.webp')
  })

  test('returns undefined when no thumb path (no full-size fallback)', () => {
    // path-only: deliberately does NOT fall back to filePath, so a thumb-
    // less attachment renders the placeholder rather than loading the full
    // blob into the thumbnail cache.
    expect(attachmentThumbPath(makeAtt({}))).toBeUndefined()
  })

  test('undefined attachment returns undefined', () => {
    expect(attachmentThumbPath(undefined)).toBeUndefined()
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

  test('train and bus also render the route arrow (transport branch)', () => {
    expect(bookingDisplayName(
      makeBooking({ type: 'train', origin: '東京', destination: '京都' }),
    )).toBe('東京 → 京都')
    expect(bookingDisplayName(
      makeBooking({ type: 'bus', origin: 'Tokyo Stn', destination: 'Hakone' }),
    )).toBe('Tokyo Stn → Hakone')
  })

  test('half route (only origin OR only destination) does NOT render arrow', () => {
    // The check uses && not ||, so a half-filled route falls through
    // to the title branch instead of showing 'NRT → undefined'.
    expect(bookingDisplayName(
      makeBooking({ type: 'flight', origin: 'NRT', title: 'NH102' }),
    )).toBe('NH102')
    expect(bookingDisplayName(
      makeBooking({ type: 'flight', destination: 'TPE', title: 'NH102' }),
    )).toBe('NH102')
  })

  test('half route with no title falls back to generic word, never half-arrow', () => {
    expect(bookingDisplayName(
      makeBooking({ type: 'flight', origin: 'NRT' }),
    )).toBe('予約')
    expect(bookingDisplayName(
      makeBooking({ type: 'flight', destination: 'TPE' }),
    )).toBe('予約')
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
  test('flight: vehicle name + provider joined with middle dot', () => {
    const b = makeBooking({ type: 'flight', title: 'NH102', provider: 'ANA' })
    expect(bookingSubtitle(b)).toBe('NH102 · ANA')
  })

  test('train and bus also include the title (transport branch)', () => {
    expect(bookingSubtitle(
      makeBooking({ type: 'train', title: 'のぞみ7号', provider: 'JR Tokai' }),
    )).toBe('のぞみ7号 · JR Tokai')
    expect(bookingSubtitle(
      makeBooking({ type: 'bus', title: 'JR Bus Kanto 8号', provider: 'JR' }),
    )).toBe('JR Bus Kanto 8号 · JR')
  })

  test('hotel skips title (title is the displayName, would be redundant)', () => {
    const b = makeBooking({ type: 'hotel', title: 'Marriott', provider: 'Booking.com' })
    expect(bookingSubtitle(b)).toBe('Booking.com')
  })

  test('other type also skips title (same non-transport rule)', () => {
    // 'other' is the catch-all -- title is the header, so subtitle
    // must not duplicate it. Only provider is allowed through.
    const b = makeBooking({ type: 'other', title: 'Museum Pass', provider: 'Tokyo National' })
    expect(bookingSubtitle(b)).toBe('Tokyo National')
  })

  test('returns empty when neither title nor provider is set', () => {
    const b = makeBooking({ type: 'flight' })
    expect(bookingSubtitle(b)).toBe('')
  })

  test('provider-only transport still renders (no title required)', () => {
    expect(bookingSubtitle(
      makeBooking({ type: 'flight', provider: 'ANA' }),
    )).toBe('ANA')
    expect(bookingSubtitle(
      makeBooking({ type: 'train', provider: 'JR East' }),
    )).toBe('JR East')
  })
})

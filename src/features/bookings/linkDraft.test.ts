import { describe, expect, test } from 'vitest'
import {
  deriveBookingLinkDraft,
  hasShareParams,
  sharedBookingDraftFromSearch,
  sharedBookingUrl,
} from './linkDraft'

describe('hasShareParams', () => {
  test('detects booking share target params consistently', () => {
    expect(hasShareParams('?url=https%3A%2F%2Fexample.com')).toBe(true)
    expect(hasShareParams('?url')).toBe(true)
    expect(hasShareParams('?foo=bar')).toBe(false)
    expect(hasShareParams('')).toBe(false)
  })
})

describe('sharedBookingUrl', () => {
  test('uses a clean url param directly', () => {
    expect(sharedBookingUrl('https://www.booking.com/hotel/jp/abc.html', null))
      .toBe('https://www.booking.com/hotel/jp/abc.html')
  })

  test('falls back to the first URL embedded in shared text', () => {
    expect(sharedBookingUrl(null, '予約 https://www.trip.com/orders/123。'))
      .toBe('https://www.trip.com/orders/123')
  })
})

describe('deriveBookingLinkDraft', () => {
  test('maps OTA platform URLs to a hotel draft with display provider label', () => {
    expect(deriveBookingLinkDraft({ link: 'https://www.airbnb.com.tw/trips/abc' }))
      .toMatchObject({
        type:     'hotel',
        title:    'Airbnb',
        provider: 'Airbnb',
        link:     'https://www.airbnb.com.tw/trips/abc',
      })
  })

  test('keeps explicit shared title while still deriving provider and type', () => {
    expect(deriveBookingLinkDraft({
      link:  'https://www.booking.com/hotel/jp/abc.html',
      title: 'Dormy Inn',
    })).toMatchObject({
      type:     'hotel',
      title:    'Dormy Inn',
      provider: 'Booking.com',
    })
  })

  test('uses other type for non-platform URLs', () => {
    expect(deriveBookingLinkDraft({ link: 'https://example.com/order/1' }))
      .toMatchObject({
        type:     'other',
        title:    'example.com',
        provider: 'example.com',
      })
  })

  test('keeps multi-vertical OTA flight URLs generic instead of forcing hotel', () => {
    // Trip.com AND Agoda sell flights — a non-lodging path must not become
    // 'hotel' just because the host is a known booking platform.
    expect(deriveBookingLinkDraft({ link: 'https://www.trip.com/flights/tokyo-osaka' }))
      .toMatchObject({ type: 'other', provider: 'Trip.com' })
    expect(deriveBookingLinkDraft({ link: 'https://www.agoda.com/flights?cid=1844104&ds=n0ky' }))
      .toMatchObject({ type: 'other', provider: 'Agoda' })
    expect(deriveBookingLinkDraft({ link: 'https://www.agoda.com/the-b-tokyo/hotel/tokyo-jp.html' }))
      .toMatchObject({ type: 'hotel', provider: 'Agoda' })
  })
})

describe('sharedBookingDraftFromSearch', () => {
  test('returns a create draft from share target params', () => {
    expect(sharedBookingDraftFromSearch(
      '?title=Dormy%20Inn&url=https%3A%2F%2Fwww.booking.com%2Fhotel%2Fjp%2Fabc.html',
    )?.draft).toMatchObject({
      type:     'hotel',
      title:    'Dormy Inn',
      provider: 'Booking.com',
      link:     'https://www.booking.com/hotel/jp/abc.html',
    })
  })
})

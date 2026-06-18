// Lock down the brand-match logic. The catalogue is hand-maintained, so
// regressions here come from two directions:
//   1. Alias drift -- someone adds a brand with an alias that accidentally
//      collides with an earlier entry, changing which Brand a stable
//      `provider` string maps to.
//   2. Cache invariants -- the WeakMap-backed `matchCache` must isolate
//      per-table state so a hotel `provider` never returns an airline Brand.
import { describe, expect, test } from 'vitest'
import { Plane, Hotel } from 'lucide-react'
import { airlineBrand, bookingPlatformBrand, hotelBrand, railBrand } from './brandMeta'

describe('airlineBrand', () => {
  test('matches IATA code regardless of case', () => {
    expect(airlineBrand('ANA').label).toBe('ANA')
    expect(airlineBrand('ana').label).toBe('ANA')
    expect(airlineBrand('jal').label).toBe('JAL')
  })

  test('matches Chinese / Japanese alias', () => {
    expect(airlineBrand('全日空').label).toBe('ANA')
    expect(airlineBrand('日本航空').label).toBe('JAL')
    expect(airlineBrand('長榮航空').label).toBe('BR')
  })

  test('matches newly added budget carriers', () => {
    expect(airlineBrand('Peach Aviation').label).toBe('MM')
    expect(airlineBrand('樂桃').label).toBe('MM')
    expect(airlineBrand('hk express').label).toBe('UO')
    expect(airlineBrand('AirAsia').label).toBe('AK')
    expect(airlineBrand('スカイマーク').label).toBe('BC')
    expect(airlineBrand('cebu pacific').label).toBe('5J')
  })

  test('substring match wins on first hit in declaration order', () => {
    // "Peach via JAL" should hit JAL first (declared earlier) then Peach;
    // matchBrand returns the FIRST hit so the earlier-declared JAL wins.
    expect(airlineBrand('Peach via JAL').label).toBe('JAL')
  })

  test('long aliases match as substring even without token boundary', () => {
    // Concatenated provider strings ("AirAsiaX", "JetstarAsia") have no
    // whitespace boundary, but the long alias ('airasia', 'jetstar')
    // must still substring-match. Regression test for the over-strict
    // whole-token-only fix that broke long brand names.
    expect(airlineBrand('AirAsiaX').label).toBe('AK')
    expect(airlineBrand('JetstarAsia').label).toBe('3K')
  })

  test('short codes do NOT match inside longer words (the original bug)', () => {
    // 'pr' (Philippine Airlines IATA) used to false-match in 'Express',
    // 'tr' (Scoot IATA) used to false-match in 'Trip'. With short-code
    // exact-token matching, both correctly fall through to fallback.
    expect(airlineBrand('hk express').label).toBe('UO')        // not PR
    expect(airlineBrand('Atlantic Wormhole Express').icon).toBe(Plane)  // not PR
    expect(airlineBrand('Trip.com').icon).toBe(Plane)          // not TR
  })

  test('unknown provider returns fallback (empty aliases)', () => {
    const fallback = airlineBrand('Atlantic Wormhole Express')
    expect(fallback.aliases).toEqual([])
    expect(fallback.icon).toBe(Plane)
  })

  test('empty / undefined provider returns fallback', () => {
    expect(airlineBrand(undefined).icon).toBe(Plane)
    expect(airlineBrand('').icon).toBe(Plane)
    expect(airlineBrand('   ').icon).toBe(Plane)
  })

  test('cache returns same Brand reference on repeat calls', () => {
    const a = airlineBrand('ANA')
    const b = airlineBrand('ANA')
    expect(a).toBe(b)  // referential equality proves cache hit
  })
})

describe('hotelBrand', () => {
  test('OTA platforms beat hotel chains when both could match', () => {
    // "Marriott via Booking.com" -- platforms come first in the array
    // so Booking should win (the reservation is held by the platform).
    expect(hotelBrand('Marriott via Booking.com').label).toBe('Booking')
  })

  test('chain matches when provider is just the chain name', () => {
    expect(hotelBrand('Marriott').label).toBe('Marriott')
    expect(hotelBrand('Hilton Garden Inn').label).toBe('Hilton')
  })

  test('matches IHG sub-brands via alias', () => {
    expect(hotelBrand('Holiday Inn Express').label).toBe('IHG')
    expect(hotelBrand('Crowne Plaza').label).toBe('IHG')
  })

  test('matches newly added chains', () => {
    expect(hotelBrand('Wyndham Garden').label).toBe('Wyndham')
    expect(hotelBrand('Days Inn').label).toBe('Wyndham')  // Wyndham subsidiary
    expect(hotelBrand('Comfort Inn').label).toBe('Choice')
    expect(hotelBrand('Regent Taipei').label).toBe('Regent')
    expect(hotelBrand('晶華酒店').label).toBe('Regent')
    expect(hotelBrand('三井ガーデンホテル').label).toBe('Mitsui')
    expect(hotelBrand('Hotel Granvia Kyoto').label).toBe('Granvia')
    expect(hotelBrand('日月行館').label).toBe('雲品')
  })

  test('Japanese chain kanji match', () => {
    expect(hotelBrand('東横イン').label).toBe('Toyoko')
    expect(hotelBrand('APAホテル').label).toBe('APA')
  })

  test('fallback uses hotel icon', () => {
    expect(hotelBrand('Random Boutique Inn').icon).toBe(Hotel)
  })
})

describe('bookingPlatformBrand', () => {
  test('matches OTA platforms independently of booking type', () => {
    expect(bookingPlatformBrand('Trip.com')?.label).toBe('Trip')
    expect(bookingPlatformBrand('Booking.com')?.label).toBe('Booking')
    expect(bookingPlatformBrand('Marriott')).toBeNull()
  })
})

describe('railBrand', () => {
  test('specific JR matches before generic JR Group', () => {
    expect(railBrand('JR East').label).toBe('JR East')
    expect(railBrand('JR Hokkaido Rail Pass').label).toBe('JR Hokkaido')
    expect(railBrand('JR Shikoku').label).toBe('JR Shikoku')
  })

  test('generic JR falls back to JR Group when no region matches', () => {
    expect(railBrand('JR Pass').label).toBe('JR')
  })

  test('matches metro / subway operators', () => {
    expect(railBrand('Tokyo Metro').label).toBe('Tokyo Metro')
    expect(railBrand('東京メトロ').label).toBe('Tokyo Metro')
    expect(railBrand('都営地下鉄').label).toBe('Toei')
    expect(railBrand('Osaka Metro').label).toBe('Osaka Metro')
  })

  test('matches Japanese private rail', () => {
    expect(railBrand('近鉄特急').label).toBe('Kintetsu')
    expect(railBrand('阪急電鉄').label).toBe('Hankyu')
    expect(railBrand('阪神電車').label).toBe('Hanshin')
    expect(railBrand('京阪電気鉄道').label).toBe('Keihan')
  })

  test('matches Taiwan / HK / Korea', () => {
    expect(railBrand('台北捷運').label).toBe('北捷')
    expect(railBrand('港鐵').label).toBe('MTR')
    expect(railBrand('台鐵').label).toBe('TRA')
    expect(railBrand('台灣高鐵').label).toBe('THSR')
    expect(railBrand('KTX').label).toBe('KTX')
  })
})

describe('short-alias token-match invariants', () => {
  // Focused regressions for the rule "short ASCII alias (<= 3) must be
  // a whole token, never a substring". These cases are the diagnostic
  // value of the entire isShortAsciiAlias() branch -- if a future change
  // loosens it back to plain .includes(), these tests catch it.

  test('"BA" alone still matches British Airways (positive whole-token hit)', () => {
    expect(airlineBrand('BA').label).toBe('BA')
    expect(airlineBrand('ba').label).toBe('BA')
  })

  test('"HK Express" does not false-match PR (substring "pr" in "express")', () => {
    expect(airlineBrand('HK Express').label).toBe('UO')
  })

  test('"Express Air" with no real match falls back, not PR', () => {
    // Tokens are ['express', 'air']; alias 'pr' must NOT match because
    // it is not a whole token (it lives inside 'express').
    expect(airlineBrand('Express Air').icon).toBe(Plane)
  })

  test('hotelBrand("Trip.com") hits Trip.com platform, not any short code', () => {
    // The airline 'tr' / 'pr' codes don't exist in the hotel table, but
    // this explicitly locks down that hotelBrand returns the Trip.com
    // platform Brand (not, say, a fallback or some other entry whose
    // long alias might collide). Cross-table isolation sanity check.
    expect(hotelBrand('Trip.com').label).toBe('Trip')
    expect(hotelBrand('Trip.com').name).toBe('Trip.com')
  })
})

describe('cache isolation across tables', () => {
  test('same provider string in different tables returns different brands', () => {
    // "Trip.com" hits the hotel platform; airline table has no such alias
    // so the airline lookup falls back. Each table caches independently,
    // so the airline cache miss must not bleed into the hotel lookup.
    expect(airlineBrand('Trip.com').icon).toBe(Plane)  // airline fallback
    expect(hotelBrand('Trip.com').label).toBe('Trip')  // hotel hit
  })
})

import { describe, expect, test } from 'vitest'
import { mapsSearchUrl, isGoogleMapsUrl, addressMapHref } from './maps'

describe('mapsSearchUrl', () => {
  test('builds a Google Maps search URL for plain ASCII', () => {
    expect(mapsSearchUrl('Tokyo Station'))
      .toBe('https://www.google.com/maps/search/?api=1&query=Tokyo%20Station')
  })

  test('URL-encodes non-ASCII characters', () => {
    expect(mapsSearchUrl('東京駅'))
      .toBe('https://www.google.com/maps/search/?api=1&query=%E6%9D%B1%E4%BA%AC%E9%A7%85')
  })

  test('URL-encodes special characters that would break the query', () => {
    const result = mapsSearchUrl('Cafe & Bar')
    expect(result).toContain('Cafe%20%26%20Bar')
  })

  test('returns null for empty string', () => {
    expect(mapsSearchUrl('')).toBeNull()
  })

  test('returns null for whitespace-only input', () => {
    expect(mapsSearchUrl('   ')).toBeNull()
    expect(mapsSearchUrl('\t\n')).toBeNull()
  })

  test('trims leading/trailing whitespace before encoding', () => {
    expect(mapsSearchUrl('  Tokyo  '))
      .toBe('https://www.google.com/maps/search/?api=1&query=Tokyo')
  })

  test('encodes ?, &, = as query value -- never leak as URL params', () => {
    // Defensive: a user pasting something like 'Hotel?id=1&utm_source=x'
    // into the address field must not let those characters become real
    // URL params (they'd override `api=1` or smuggle tracking). They
    // must be percent-encoded inside the single `query=` value.
    const url = mapsSearchUrl('Hotel?id=123&utm_source=evil')
    expect(url).toBe(
      'https://www.google.com/maps/search/?api=1&query=Hotel%3Fid%3D123%26utm_source%3Devil',
    )
    // Round-trip parse: only `api` and `query` should be visible at
    // the URL-param level; the injection chars stay buried in the value.
    const parsed = new URL(url!)
    expect([...parsed.searchParams.keys()].sort()).toEqual(['api', 'query'])
    expect(parsed.searchParams.get('id')).toBeNull()
    expect(parsed.searchParams.get('utm_source')).toBeNull()
  })
})

describe('isGoogleMapsUrl', () => {
  test('accepts real Google Maps URL shapes', () => {
    expect(isGoogleMapsUrl('https://www.google.com/maps/place/Tokyo+Tower')).toBe(true)
    expect(isGoogleMapsUrl('https://google.com/maps?q=35.6,139.7')).toBe(true)
    expect(isGoogleMapsUrl('https://maps.google.com/?q=Tokyo')).toBe(true)
    expect(isGoogleMapsUrl('https://maps.app.goo.gl/AbCdEf123')).toBe(true)
    expect(isGoogleMapsUrl('https://goo.gl/maps/AbCdEf')).toBe(true)
    expect(isGoogleMapsUrl('https://www.google.co.jp/maps/place/X')).toBe(true)
    expect(isGoogleMapsUrl('https://maps.google.co.uk/?q=X')).toBe(true)
  })

  test('rejects look-alike / spoofed hosts (END-anchored)', () => {
    expect(isGoogleMapsUrl('https://maps.google.com.evil.com/maps')).toBe(false)
    expect(isGoogleMapsUrl('https://notgoogle.com/maps')).toBe(false)
    expect(isGoogleMapsUrl('https://google.evil.com/maps')).toBe(false)
    expect(isGoogleMapsUrl('https://goo.gl/short')).toBe(false)           // not /maps
    expect(isGoogleMapsUrl('https://mail.google.com/mail')).toBe(false)   // google but not maps
  })

  test('rejects http: Maps URLs (no HTTP downgrade from user input)', () => {
    expect(isGoogleMapsUrl('http://maps.google.com/?q=Tokyo')).toBe(false)
    expect(isGoogleMapsUrl('http://www.google.com/maps/place/X')).toBe(false)
    expect(isGoogleMapsUrl('http://maps.app.goo.gl/AbCd')).toBe(false)
  })

  test('rejects non-Maps URLs and junk', () => {
    expect(isGoogleMapsUrl('https://phish.example')).toBe(false)
    expect(isGoogleMapsUrl('http://example.com/maps')).toBe(false)
    expect(isGoogleMapsUrl('javascript:alert(1)')).toBe(false)
    expect(isGoogleMapsUrl('東京都港区')).toBe(false)
    expect(isGoogleMapsUrl('')).toBe(false)
  })
})

describe('addressMapHref', () => {
  test('returns a Maps URL as-is', () => {
    const u = 'https://maps.app.goo.gl/AbCdEf123'
    expect(addressMapHref(u)).toBe(u)
  })

  test('wraps plain address text into a Maps search', () => {
    expect(addressMapHref('東京都港区芝公園 4-2-8'))
      .toBe('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('東京都港区芝公園 4-2-8'))
  })

  test('wraps a NON-Maps URL into a search (never opens it as a link)', () => {
    // Security: a phishing URL stored in `address` must NOT become a
    // direct external link — it lands on a Google Maps search instead.
    const href = addressMapHref('https://phish.example/login')
    expect(href).toBe(
      'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent('https://phish.example/login'),
    )
    expect(new URL(href!).hostname).toBe('www.google.com')
  })

  test('does NOT pass through an http: Maps URL — wraps it in a search', () => {
    const href = addressMapHref('http://maps.google.com/?q=Tokyo')
    expect(new URL(href!).hostname).toBe('www.google.com')
    expect(new URL(href!).protocol).toBe('https:')
  })

  test('trims and treats empty / whitespace as null', () => {
    expect(addressMapHref('  https://maps.app.goo.gl/X  ')).toBe('https://maps.app.goo.gl/X')
    expect(addressMapHref('')).toBeNull()
    expect(addressMapHref('   ')).toBeNull()
    expect(addressMapHref(undefined)).toBeNull()
    expect(addressMapHref(null)).toBeNull()
  })
})

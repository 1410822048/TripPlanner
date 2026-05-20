import { describe, expect, test } from 'vitest'
import { mapsSearchUrl } from './maps'

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

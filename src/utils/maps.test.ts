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
})

import { describe, expect, test } from 'vitest'
import { googleMapsDirectionsUrl } from './routePlanner'

describe('Google Maps route links', () => {
  test('builds a keyless Google Maps transit deep link from verified coordinates', () => {
    const url = new URL(googleMapsDirectionsUrl(
      { lat: 35.6812, lng: 139.7671 },
      { lat: 35.6586, lng: 139.7454 },
      'transit',
    ))

    expect(url.origin + url.pathname).toBe('https://www.google.com/maps/dir/')
    expect(url.searchParams.get('api')).toBe('1')
    expect(url.searchParams.get('origin')).toBe('35.6812,139.7671')
    expect(url.searchParams.get('destination')).toBe('35.6586,139.7454')
    expect(url.searchParams.get('travelmode')).toBe('transit')
    expect(url.searchParams.has('key')).toBe(false)
  })

  test('builds a keyless Google Maps walking deep link from verified coordinates', () => {
    const url = new URL(googleMapsDirectionsUrl(
      { lat: 35.6812, lng: 139.7671 },
      { lat: 35.6586, lng: 139.7454 },
      'walking',
    ))

    expect(url.searchParams.get('travelmode')).toBe('walking')
    expect(url.searchParams.has('key')).toBe(false)
  })

  test('rejects invalid coordinates instead of producing an unsafe link', () => {
    expect(() => googleMapsDirectionsUrl(
      { lat: 91, lng: 139.7 },
      { lat: 35.6, lng: 139.8 },
      'transit',
    )).toThrow(/coordinate/i)
  })
})

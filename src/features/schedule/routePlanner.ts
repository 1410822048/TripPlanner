import { assertCoordinate, type Coordinate } from '@tripmate/route-estimate-core'

export type GoogleMapsTravelMode = 'walking' | 'transit'
type GoogleMapsDirectionsPoint = Coordinate | string

function directionsPointValue(point: GoogleMapsDirectionsPoint): string {
  if (typeof point === 'string') {
    const value = point.trim()
    if (!value || value.length > 500) throw new Error('invalid route place name')
    return value
  }
  assertCoordinate(point)
  return `${point.lat},${point.lng}`
}

/** Google Maps URLs accept origin/destination without an API key. They are a
 * one-way navigation link only; TripMate never scrapes or reads route data
 * back from Google Maps. */
export function googleMapsDirectionsUrl(
  origin: GoogleMapsDirectionsPoint,
  destination: GoogleMapsDirectionsPoint,
  travelMode: GoogleMapsTravelMode,
): string {
  const url = new URL('https://www.google.com/maps/dir/')
  url.searchParams.set('api', '1')
  url.searchParams.set('origin', directionsPointValue(origin))
  url.searchParams.set('destination', directionsPointValue(destination))
  url.searchParams.set('travelmode', travelMode)
  return url.toString()
}

import {
  estimateTransitRange,
  WALKING_DIRECT_THRESHOLD_MINUTES,
} from '@tripmate/route-estimate-core'

interface CoordinateInput {
  lat: number
  lng: number
}

export type GoogleMapsTravelMode = 'walking' | 'transit'
type GoogleMapsDirectionsPoint = CoordinateInput | string

export type TravelSegmentEstimate =
  | { kind: 'walking'; minutes: number }
  | { kind: 'transit'; minMinutes: number; maxMinutes: number }

const EARTH_RADIUS_METERS = 6_371_000
const WALKING_ROUTE_FACTOR = 1.25
const WALKING_METERS_PER_MINUTE = 80

function assertCoordinate({ lat, lng }: CoordinateInput): void {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90
      || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new Error('invalid route coordinate')
  }
}

function directionsPointValue(point: GoogleMapsDirectionsPoint): string {
  if (typeof point === 'string') {
    const value = point.trim()
    if (!value || value.length > 500) throw new Error('invalid route place name')
    return value
  }
  assertCoordinate(point)
  return `${point.lat},${point.lng}`
}

function radians(value: number): number {
  return value * Math.PI / 180
}

function directDistanceMeters(origin: CoordinateInput, destination: CoordinateInput): number {
  const latitudeDelta = radians(destination.lat - origin.lat)
  const longitudeDelta = radians(destination.lng - origin.lng)
  const originLatitude = radians(origin.lat)
  const destinationLatitude = radians(destination.lat)
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(originLatitude) * Math.cos(destinationLatitude) * Math.sin(longitudeDelta / 2) ** 2
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(Math.min(1, haversine)))
}

/** Cheap display-only estimate for the daily timeline. The route preview
 * remains authoritative because it uses ORS network distance; this local
 * estimate deliberately performs no provider request on page load. */
export function estimateTravelSegment(
  origin: CoordinateInput,
  destination: CoordinateInput,
): TravelSegmentEstimate {
  assertCoordinate(origin)
  assertCoordinate(destination)
  const referenceDistanceMeters = directDistanceMeters(origin, destination) * WALKING_ROUTE_FACTOR
  const walkingMinutes = Math.max(1, Math.ceil(referenceDistanceMeters / WALKING_METERS_PER_MINUTE))
  if (walkingMinutes <= WALKING_DIRECT_THRESHOLD_MINUTES) {
    return { kind: 'walking', minutes: walkingMinutes }
  }

  return { kind: 'transit', ...estimateTransitRange(referenceDistanceMeters) }
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

interface CoordinateInput {
  lat: number
  lng: number
}

export type GoogleMapsTravelMode = 'walking' | 'transit'

function assertCoordinate({ lat, lng }: CoordinateInput): void {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90
      || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new Error('invalid route coordinate')
  }
}

/** Google Maps URLs accept origin/destination without an API key. They are a
 * one-way navigation link only; TripMate never scrapes or reads route data
 * back from Google Maps. */
export function googleMapsDirectionsUrl(
  origin: CoordinateInput,
  destination: CoordinateInput,
  travelMode: GoogleMapsTravelMode,
): string {
  assertCoordinate(origin)
  assertCoordinate(destination)
  const url = new URL('https://www.google.com/maps/dir/')
  url.searchParams.set('api', '1')
  url.searchParams.set('origin', `${origin.lat},${origin.lng}`)
  url.searchParams.set('destination', `${destination.lat},${destination.lng}`)
  url.searchParams.set('travelmode', travelMode)
  return url.toString()
}

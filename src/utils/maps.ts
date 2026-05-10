// src/utils/maps.ts
// Build a Google Maps deep-link URL for a free-text query (street
// address, place name, or lat/lng — Google resolves all three through
// the same /maps/search endpoint).
//
// On iOS / Android the link is a Universal Link — clicking it opens
// the native Maps app when installed, otherwise the Maps web page.
// Used by WishCard's address chip + TimelineCard's location chip;
// add new callers here rather than re-deriving the URL shape.

const SEARCH_BASE = 'https://www.google.com/maps/search/?api=1&query='

/** Build the Google Maps search URL for a free-text query. Empty
 *  input returns null so callers can decide whether to render the
 *  chip at all rather than emitting a search for "". */
export function mapsSearchUrl(query: string): string | null {
  const trimmed = query.trim()
  if (!trimmed) return null
  return SEARCH_BASE + encodeURIComponent(trimmed)
}

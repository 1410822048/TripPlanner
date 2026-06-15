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

/** True iff `raw` is a Google Maps URL (web map or share short-link).
 *  Gate for the map affordance: ONLY Maps-shaped URLs are opened as-is;
 *  anything else is treated as text and routed through a Maps SEARCH, so
 *  the address field can never become an open-redirect to an arbitrary
 *  external site (a raw-SDK / legacy `address: https://phish.example`
 *  would otherwise get a "地図" affordance opening the phishing page).
 *
 *  Hostname is parsed + END-anchored so `maps.google.com.evil.com` and
 *  `notgoogle.com` can't slip through a naive substring check. */
export function isGoogleMapsUrl(raw: string): boolean {
  let url: URL
  try { url = new URL(raw.trim()) } catch { return false }
  // https only — http(s downgrade) Maps URLs fall through to a Maps search
  // rather than becoming a direct HTTP navigation from a user-supplied field.
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  const path = url.pathname.toLowerCase()
  // Share short-links.
  if (host === 'maps.app.goo.gl') return true
  if (host === 'goo.gl') return path.startsWith('/maps')
  // Google domain (apex / subdomain / ccTLD), anchored to the END.
  const googleDomain =
    host === 'google.com' ||
    host.endsWith('.google.com') ||
    /(?:^|\.)google\.(?:com?\.)?[a-z]{2,3}$/.test(host)
  if (!googleDomain) return false
  // The maps subdomain or a /maps path on that google domain.
  return host.startsWith('maps.google.') || path.startsWith('/maps')
}

/** Resolve a location field that is EITHER free text (address / place
 *  name) OR a Google Maps URL into a tappable href. A *Maps* URL is opened
 *  as-is (the exact map the user pasted); ANY other value — plain text OR a
 *  non-Maps URL — is wrapped into a Maps SEARCH, so the result always lands
 *  on Google Maps and never on an attacker-controlled site. Empty → null.
 *  Shared by wish + booking cards so the rule lives in one place. */
export function addressMapHref(value: string | undefined | null): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  if (isGoogleMapsUrl(trimmed)) return trimmed
  return mapsSearchUrl(trimmed)
}

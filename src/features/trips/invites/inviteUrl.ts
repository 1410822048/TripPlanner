const TRIP_ID_RE = /^[A-Za-z0-9_-]{1,60}$/
const TOKEN_RE = /^[A-Fa-f0-9]{64}$/
const PAGES_HOST = 'tripmate-2wg.pages.dev'

export interface ParsedInviteUrl {
  tripId: string
  token:  string
}

export function buildInviteUrl(tripId: string, token: string, origin = window.location.origin): string {
  return `${origin}/invite/${tripId}#${token}`
}

function isAllowedInviteOrigin(url: URL, base: URL): boolean {
  if (url.origin === base.origin) return true
  if (url.protocol !== 'https:') return false
  return url.hostname === PAGES_HOST || url.hostname.endsWith(`.${PAGES_HOST}`)
}

export function parseInviteUrl(value: string, baseOrigin = window.location.origin): ParsedInviteUrl | null {
  const raw = value.trim()
  if (!raw) return null

  let url: URL
  let base: URL
  try {
    base = new URL(baseOrigin)
    url = new URL(raw, base.origin)
  } catch {
    return null
  }

  if (!isAllowedInviteOrigin(url, base)) return null

  const match = url.pathname.match(/^\/invite\/([^/]+)\/?$/)
  if (!match?.[1]) return null

  let tripId: string
  try {
    tripId = decodeURIComponent(match[1])
  } catch {
    return null
  }

  const token = url.hash.startsWith('#') ? url.hash.slice(1) : ''
  if (!TRIP_ID_RE.test(tripId) || !TOKEN_RE.test(token)) return null

  return { tripId, token }
}

// workers/ocr/src/admin.ts
// Mint a Google OAuth access token from a Firebase service-account JSON,
// then use it to call Firestore REST API at admin privilege (bypassing
// security rules). Used by Worker-authoritative endpoints to update
// membership projections and other server-owned data. Clients cannot
// list or mutate those projections directly under same-doc memberIds rules.
//
// Cache the OAuth token in-process for its lifetime. Workers reuse the
// same instance for many requests, so token reuse saves the ~150ms
// JWT-sign + token-exchange round-trip on subsequent calls.
//
// All HTTP via fetch + WebCrypto for signing. NO firebase-admin SDK —
// it requires Node APIs that aren't in the Workers runtime.
import { importPKCS8, SignJWT } from 'jose'

interface ServiceAccount {
  client_email: string
  private_key:  string
  token_uri:    string  // 'https://oauth2.googleapis.com/token'
  project_id:   string
}

interface CachedToken {
  accessToken: string
  expiresAtMs: number  // epoch ms
}
let cached: CachedToken | null = null

// Parsed-JSON cache — same env string per instance, no need to
// JSON.parse on every getAdminToken / getProjectId call. Keyed by
// string identity to stay correct if a future caller swaps the
// service account (e.g. rotation).
let saCache: { json: string; parsed: ServiceAccount } | null = null
function parseServiceAccount(json: string): ServiceAccount {
  if (saCache && saCache.json === json) return saCache.parsed
  const parsed = JSON.parse(json) as ServiceAccount
  saCache = { json, parsed }
  return parsed
}

/** Returns a Google OAuth 2.0 access token scoped for Firestore admin
 *  access. Reuses an in-process cache until ~60s before expiry. */
export async function getAdminToken(serviceAccountJson: string): Promise<string> {
  const now = Date.now()
  if (cached && cached.expiresAtMs > now + 60_000) {
    return cached.accessToken
  }

  const sa = parseServiceAccount(serviceAccountJson)
  const iat = Math.floor(now / 1000)
  const exp = iat + 3600  // 1h is the max Google accepts

  // Service-account self-signed JWT → exchanged for an access token.
  // Scopes:
  //   - datastore             (Firestore REST: cascade member/trip-delete)
  //   - devstorage.read_write (GCS REST: list/delete trip Storage assets
  //                            for trip-cascade + 10-day receipt purge)
  // Both scopes go on the SAME access token so we keep one cache slot —
  // splitting per-scope would double JWT-sign + token-exchange overhead
  // for no real isolation benefit (the underlying service account already
  // has full IAM on both APIs).
  const key = await importPKCS8(sa.private_key, 'RS256')
  const jwt = await new SignJWT({
    scope: [
      'https://www.googleapis.com/auth/datastore',
      'https://www.googleapis.com/auth/devstorage.read_write',
    ].join(' '),
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(sa.client_email)
    .setSubject(sa.client_email)
    .setAudience(sa.token_uri)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(key)

  const res = await fetch(sa.token_uri, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  jwt,
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '<unreadable>')
    throw new Error(`getAdminToken token exchange failed: ${res.status} ${detail.slice(0, 200)}`)
  }
  const data = await res.json() as { access_token: string; expires_in: number }
  cached = {
    accessToken: data.access_token,
    expiresAtMs: now + data.expires_in * 1000,
  }
  return data.access_token
}

/** Parsed service account fields the cascade endpoint needs beyond
 *  the JWT signing flow. project_id keeps us from hard-coding a worker
 *  env var that already lives in the JSON. */
export function getProjectId(serviceAccountJson: string): string {
  return parseServiceAccount(serviceAccountJson).project_id
}

/** Drop the cached OAuth token. Call when a downstream Firestore REST
 *  call returns 401 — the cached token is presumed bad (e.g. the
 *  service account key was rotated mid-cache, or Google revoked it).
 *  Next getAdminToken() call mints fresh. */
export function invalidateAdminToken(): void {
  cached = null
}

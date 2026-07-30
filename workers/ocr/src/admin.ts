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

// ─── Token-exchange resilience ────────────────────────────────────
// The OAuth token endpoint is an external dependency on the cold-start
// path of EVERY Worker-authoritative request (mint-on-first-call, or
// after a 401 invalidation). A transient hiccup there (Google 5xx, a
// network blip, a slow response) would otherwise throw straight to the
// route's generic 500 -- the availability gap behind intermittent,
// unreproducible 500s. So each attempt is bounded by a timeout and
// transient failures retry a couple times. Permanent failures (4xx --
// bad/rotated key, invalid_grant) throw immediately: retrying can't help.
const TOKEN_EXCHANGE_TIMEOUT_MS   = 5_000
const TOKEN_EXCHANGE_MAX_ATTEMPTS = 3

function tokenBackoffMs(attempt: number): number {
  return Math.min(150 * 2 ** attempt, 1_000)  // 150ms, 300ms, 600ms…
}
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

interface TokenExchangeResponse { access_token: string; expires_in: number }

/** POST the signed JWT assertion to the token endpoint, with per-attempt
 *  timeout + transient retry. The JWT is signed ONCE by the caller and
 *  reused across attempts (its 1h validity dwarfs the retry window). */
async function exchangeToken(tokenUri: string, jwt: string): Promise<TokenExchangeResponse> {
  let lastErr: unknown
  for (let attempt = 0; attempt < TOKEN_EXCHANGE_MAX_ATTEMPTS; attempt++) {
    let res: Response
    try {
      res = await fetch(tokenUri, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion:  jwt,
        }),
        signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
      })
    } catch (e) {
      // Network failure / AbortSignal timeout -- transient, retry.
      lastErr = e
      if (attempt < TOKEN_EXCHANGE_MAX_ATTEMPTS - 1) { await sleep(tokenBackoffMs(attempt)); continue }
      break
    }
    if (res.ok) {
      return await res.json() as TokenExchangeResponse
    }
    const detail = await res.text().catch(() => '<unreadable>')
    // 4xx is permanent (invalid_grant / bad key) -- fail fast, original
    // message shape preserved so callers / logs read the same as before.
    if (res.status < 500) {
      throw new Error(`getAdminToken token exchange failed: ${res.status} ${detail.slice(0, 200)}`)
    }
    // 5xx -- Google token endpoint transient. Retry.
    lastErr = new Error(`getAdminToken token exchange failed: ${res.status} ${detail.slice(0, 200)}`)
    if (attempt < TOKEN_EXCHANGE_MAX_ATTEMPTS - 1) { await sleep(tokenBackoffMs(attempt)); continue }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`getAdminToken token exchange failed: ${String(lastErr)}`)
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
  // Only Firestore REST is accessed with this token. Attachments use the
  // in-process R2 binding and require no Google Cloud Storage OAuth scope.
  const key = await importPKCS8(sa.private_key, 'RS256')
  const jwt = await new SignJWT({
    scope: 'https://www.googleapis.com/auth/datastore',
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(sa.client_email)
    .setSubject(sa.client_email)
    .setAudience(sa.token_uri)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(key)

  const data = await exchangeToken(sa.token_uri, jwt)
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

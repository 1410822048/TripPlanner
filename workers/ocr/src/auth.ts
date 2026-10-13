// Firebase ID token verification.
//
// Why jose + createRemoteJWKSet: it does what we want with five lines.
// Firebase rotates its securetoken JWKs every few hours; createRemoteJWKSet
// fetches them on first use, caches per the Cache-Control header, and
// re-fetches when a token references an unseen kid. We don't have to write
// any cache logic ourselves — and crucially, we don't bundle firebase-admin
// (which doesn't work in the Workers runtime anyway).
import {
  createRemoteJWKSet,
  customFetch,
  errors,
  jwtVerify,
  type JWTPayload,
} from 'jose'
import { emulatorActive, verifyEmulatorToken } from './emulator'

/** Google's JWKS endpoint could not be reached (network failure). Tagged
 *  so the caller can tell "we could not check the token" apart from "the
 *  token is bad": the former is a 503, never a 401. */
export class JwksUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`JWKS fetch failed: ${(cause as Error)?.message ?? String(cause)}`, { cause })
    this.name = 'JwksUnavailableError'
  }
}

/** True when verification failed because the key set could not be loaded,
 *  not because of anything about the token. jose throws JWKSTimeout for a
 *  timeout and a bare JOSEError (code ERR_JOSE_GENERIC — only the remote-
 *  JWKS fetch uses it) for a non-200 / unparseable response; a network
 *  failure is tagged by the customFetch wrapper below. Every token defect
 *  is a JOSEError SUBCLASS with its own code, so it stays a 401. */
export function isJwksUnavailable(e: unknown): boolean {
  return e instanceof JwksUnavailableError
    || e instanceof errors.JWKSTimeout
    || (e instanceof errors.JOSEError && e.code === 'ERR_JOSE_GENERIC')
}

// Module-level cache: createRemoteJWKSet returns a stateful getKey function
// with its own internal cache. Reusing the same instance across requests
// means the second request hits cache, not network.
const JWKS = createRemoteJWKSet(new URL(
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
), {
  // jose rethrows a raw network error untouched; tag it (the timeout case
  // is already mapped to JWKSTimeout by jose, so leave that one alone).
  [customFetch]: (url, init) => fetch(url, init).catch((e: unknown) => {
    if ((e as Error)?.name === 'TimeoutError') throw e
    throw new JwksUnavailableError(e)
  }),
})

export interface FirebaseTokenClaims extends JWTPayload {
  /** Firebase UID. Always present on valid tokens. */
  sub:   string
  email?: string
}

/**
 * Verify a Firebase ID token. Throws on any failure (bad signature, expired,
 * wrong issuer/audience). Caller handles the throw → 401, except a key-set
 * fetch failure (isJwksUnavailable) → 503.
 */
export async function verifyFirebaseToken(
  token:     string,
  projectId: string,
): Promise<FirebaseTokenClaims> {
  // Local emulator runs only (emulator.ts): unsigned Auth-emulator tokens.
  if (emulatorActive()) return verifyEmulatorToken(token, projectId)
  const { payload } = await jwtVerify(token, JWKS, {
    issuer:   `https://securetoken.google.com/${projectId}`,
    audience: projectId,
  })
  if (typeof payload.sub !== 'string' || !payload.sub) {
    throw new Error('Token missing sub claim')
  }
  return payload as FirebaseTokenClaims
}

/** Extract bearer token from Authorization header. Returns null when absent
 *  or malformed — caller treats that as 401. Scheme match is case-insensitive
 *  per RFC 6750 / RFC 7235 (`Bearer`, `bearer`, `BEARER` all valid). */
export function extractBearerToken(req: Request): string | null {
  const auth = req.headers.get('Authorization')
  if (!auth) return null
  const m = /^Bearer\s+(.+)$/i.exec(auth)
  return m ? m[1].trim() : null
}

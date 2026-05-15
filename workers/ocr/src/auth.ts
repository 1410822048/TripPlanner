// Firebase ID token verification.
//
// Why jose + createRemoteJWKSet: it does what we want with five lines.
// Firebase rotates its securetoken JWKs every few hours; createRemoteJWKSet
// fetches them on first use, caches per the Cache-Control header, and
// re-fetches when a token references an unseen kid. We don't have to write
// any cache logic ourselves — and crucially, we don't bundle firebase-admin
// (which doesn't work in the Workers runtime anyway).
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'

// Module-level cache: createRemoteJWKSet returns a stateful getKey function
// with its own internal cache. Reusing the same instance across requests
// means the second request hits cache, not network.
const JWKS = createRemoteJWKSet(new URL(
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
))

export interface FirebaseTokenClaims extends JWTPayload {
  /** Firebase UID. Always present on valid tokens. */
  sub:   string
  email?: string
}

/**
 * Verify a Firebase ID token. Throws on any failure (bad signature, expired,
 * wrong issuer/audience). Caller handles the throw → 401.
 */
export async function verifyFirebaseToken(
  token:     string,
  projectId: string,
): Promise<FirebaseTokenClaims> {
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
 *  or malformed — caller treats that as 401. */
export function extractBearerToken(req: Request): string | null {
  const auth = req.headers.get('Authorization')
  if (!auth) return null
  const m = /^Bearer (.+)$/.exec(auth)
  return m ? m[1] : null
}

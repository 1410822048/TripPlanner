// workers/ocr/src/emulator.ts
// Local Firebase-emulator mode, for end-to-end runs on a developer machine
// (`npm run dev:emulator`, wrangler.emulator.jsonc). Off unless BOTH of
// Firebase's standard variables are set:
//   FIRESTORE_EMULATOR_HOST       Firestore REST goes to http://<host>/v1
//   FIREBASE_AUTH_EMULATOR_HOST   ID tokens are the Auth emulator's
//                                 unsigned tokens; admin calls use the
//                                 emulator's "owner" credential
// and then only for a `demo-` project (Firebase reserves that prefix for
// emulator-only projects: no real project can have it) with both hosts on
// loopback. Anything else is a misconfiguration and every request fails
// loudly instead of half-trusting unsigned tokens. Production config sets
// none of this, so every function here returns the production behaviour.
import { decodeJwt, decodeProtectedHeader, type JWTPayload } from 'jose'

export const PRODUCTION_FIRESTORE_BASE = 'https://firestore.googleapis.com/v1'

export interface EmulatorEnv {
  FIRESTORE_EMULATOR_HOST?:     string
  FIREBASE_AUTH_EMULATOR_HOST?: string
  FIREBASE_PROJECT_ID:          string
  FIREBASE_SERVICE_ACCOUNT:     string
}

let active: { firestoreBase: string } | null = null

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/

/** Apply the environment's emulator settings. Called at the top of every
 *  fetch / scheduled invocation (env is constant per deployment, so this is
 *  idempotent). Throws on any half-configured or non-demo setup. */
export function configureEmulators(env: EmulatorEnv): void {
  const firestoreHost = env.FIRESTORE_EMULATOR_HOST
  const authHost      = env.FIREBASE_AUTH_EMULATOR_HOST
  if (!firestoreHost && !authHost) {
    active = null
    return
  }
  active = null
  if (!firestoreHost || !authHost) {
    throw new Error('emulator mode needs both FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST')
  }
  if (!LOOPBACK.test(firestoreHost) || !LOOPBACK.test(authHost)) {
    throw new Error('emulator hosts must be loopback (127.0.0.1 / localhost)')
  }
  let serviceAccountProject: unknown
  try {
    serviceAccountProject = (JSON.parse(env.FIREBASE_SERVICE_ACCOUNT) as { project_id?: unknown }).project_id
  } catch {
    serviceAccountProject = undefined
  }
  if (!env.FIREBASE_PROJECT_ID.startsWith('demo-') || serviceAccountProject !== env.FIREBASE_PROJECT_ID) {
    throw new Error('emulator mode is only allowed for a demo- project (FIREBASE_PROJECT_ID and the service account)')
  }
  active = { firestoreBase: `http://${firestoreHost}/v1` }
}

export function emulatorActive(): boolean {
  return active !== null
}

/** Base URL of the Firestore REST API (production unless emulator mode). */
export function firestoreRestBase(): string {
  return active?.firestoreBase ?? PRODUCTION_FIRESTORE_BASE
}

/** The emulator's admin credential: requests bearing it bypass rules. */
export const EMULATOR_ADMIN_TOKEN = 'owner'

/** Verify an Auth-emulator ID token. They are unsigned (`alg: none`), so
 *  only the claims can be checked — which is why this is reachable only in
 *  emulator mode, and why a signed token is refused here: in emulator mode
 *  nothing but emulator accounts may sign in. */
export function verifyEmulatorToken(token: string, projectId: string): JWTPayload & { sub: string } {
  if (!active) throw new Error('not in emulator mode')
  if (decodeProtectedHeader(token).alg !== 'none') throw new Error('not an emulator token')
  const payload = decodeJwt(token)
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('unexpected "iss" claim value')
  if (payload.aud !== projectId) throw new Error('unexpected "aud" claim value')
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) throw new Error('"exp" claim timestamp check failed')
  if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('Token missing sub claim')
  return payload as JWTPayload & { sub: string }
}

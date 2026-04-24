// src/services/firebase.ts
// Firebase SDK is the heaviest dep in the bundle (~200KB gz). We defer it
// behind dynamic imports so the demo mode (no real tripId → query hooks
// disabled → no service calls) ships zero firebase code. Separate bundles
// for firestore and auth let each feature pay only for what it uses.
import type { FirebaseApp } from 'firebase/app'
import type { Firestore } from 'firebase/firestore'
import type { Auth } from 'firebase/auth'
import type * as firestoreModule from 'firebase/firestore'
import type * as authModule from 'firebase/auth'

export type FirestoreModule = typeof firestoreModule
export type AuthModule      = typeof authModule

export interface FirebaseBundle extends FirestoreModule {
  db: Firestore
}
export interface AuthBundle extends AuthModule {
  auth: Auth
}

// Fail-fast in production builds when required Firebase env vars are missing.
// Dev builds fall back to "demo" placeholders so a fresh checkout still boots
// (in demo/preview mode) without a full .env setup, but a missing value in
// production would silently point the app at a non-existent project and fail
// on the first write. Throwing here makes the failure loud + early.
const REQUIRED_FIREBASE_ENV = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_APP_ID',
] as const
if (import.meta.env.PROD) {
  const missing = REQUIRED_FIREBASE_ENV.filter(k => !import.meta.env[k])
  if (missing.length > 0) {
    throw new Error(
      `[firebase.ts] Missing required env in production build: ${missing.join(', ')}. ` +
      `Set these via .env.production or your hosting provider's config and rebuild.`,
    )
  }
}

const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY             ?? 'demo',
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN         ?? 'demo.firebaseapp.com',
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID          ?? 'demo',
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET      ?? 'demo.appspot.com',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '000000',
  appId:             import.meta.env.VITE_FIREBASE_APP_ID              ?? '1:000000:web:demo',
}

let appPromise: Promise<FirebaseApp> | null = null
function getApp(): Promise<FirebaseApp> {
  if (appPromise) return appPromise
  appPromise = (async () => {
    const m = await import('firebase/app')
    return m.getApps().length === 0 ? m.initializeApp(firebaseConfig) : m.getApp()
  })()
  return appPromise
}

let bundlePromise: Promise<FirebaseBundle> | null = null

/**
 * Lazy-load + initialize the Firestore bundle. Cached: subsequent calls
 * resolve to the same instance. Returns the firestore module re-exported
 * alongside the initialized `db` — callers destructure what they need,
 * avoiding per-call dynamic imports.
 *
 * Persistence: enabled via `persistentLocalCache` so reads survive across
 * page reloads and work offline (critical for a travel PWA where users are
 * often on spotty connections abroad). Multi-tab manager allows two
 * browser tabs to share the same cache without one locking the other out.
 * Writes made offline are queued in IndexedDB and flushed when connectivity
 * returns. Failure to init persistence is non-fatal — we fall back to the
 * default in-memory cache.
 */
export function getFirebase(): Promise<FirebaseBundle> {
  if (bundlePromise) return bundlePromise
  bundlePromise = (async () => {
    const [app, fs] = await Promise.all([getApp(), import('firebase/firestore')])
    // `ignoreUndefinedProperties` lets optional form fields pass through as
    // `undefined` without triggering "Unsupported field value: undefined".
    // Second call on HMR throws; swallow and fall through to the existing instance.
    try {
      fs.initializeFirestore(app, {
        ignoreUndefinedProperties: true,
        localCache: fs.persistentLocalCache({
          tabManager: fs.persistentMultipleTabManager(),
        }),
      })
    } catch { /* already initialized (HMR or second call) */ }
    return { db: fs.getFirestore(app), ...fs }
  })()
  return bundlePromise
}

let authBundlePromise: Promise<AuthBundle> | null = null

/**
 * Lazy-load + initialize the Auth bundle. Kept separate from the Firestore
 * bundle so demo-mode pages that only read mocks don't pull ~40KB gz of
 * auth code. Callers should gate subscription on `!isDemo`.
 */
export function getFirebaseAuth(): Promise<AuthBundle> {
  if (authBundlePromise) return authBundlePromise
  authBundlePromise = (async () => {
    const [app, authMod] = await Promise.all([getApp(), import('firebase/auth')])
    return { auth: authMod.getAuth(app), ...authMod }
  })()
  return authBundlePromise
}

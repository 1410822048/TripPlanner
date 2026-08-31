// src/services/firebase.ts
// Firebase SDK is the heaviest dep in the bundle (~200KB gz). We defer it
// behind dynamic imports so the demo mode (no real tripId → query hooks
// disabled → no service calls) ships zero firebase code. Separate bundles
// for firestore and auth let each feature pay only for what it uses.
import { captureError } from '@/services/sentry'
import type { FirebaseApp } from 'firebase/app'
import type { Firestore } from 'firebase/firestore'
import type { Auth } from 'firebase/auth'
import type { Messaging } from 'firebase/messaging'
import type * as firestoreModule from 'firebase/firestore'
import type * as authModule from 'firebase/auth'
import type * as messagingModule from 'firebase/messaging'

export type FirestoreModule = typeof firestoreModule
export type AuthModule      = typeof authModule
export type MessagingModule = typeof messagingModule

export interface FirebaseBundle extends FirestoreModule {
  db: Firestore
}
export interface AuthBundle extends AuthModule {
  auth: Auth
}
export interface MessagingBundle extends MessagingModule {
  messaging: Messaging
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
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_VAPID_KEY',
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
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '000000',
  appId:             import.meta.env.VITE_FIREBASE_APP_ID              ?? '1:000000:web:demo',
}

/** Local emulator mode is explicit and dev-only. It uses memory caches so a
 * reset cannot leak IndexedDB state between role/browser scenarios. */
export const FIREBASE_EMULATOR_MODE = import.meta.env.DEV && import.meta.env.VITE_USE_FIREBASE_EMULATORS === 'true'
const EMULATOR_HOST = import.meta.env.VITE_FIREBASE_EMULATOR_HOST ?? '127.0.0.1'
const EMULATOR_PORTS = { auth: 9099, firestore: 8080 } as const

// Production defaults to bounded long-polling because some Chromium/HTTP3
// paths repeatedly terminate Firestore's idle WebChannel with
// QUIC_NETWORK_IDLE_TIMEOUT. A 25-second server timeout closes each hanging
// GET before the affected network path does. Set the local/CI build-time flag
// to `false` through `.env.production` or the CI environment to return to the
// SDK's default auto-detection after the upstream issue is resolved. This
// direct-upload deploy does not read Pages dashboard variables at runtime.
// Dev/emulator traffic always keeps auto mode.
const FORCE_FIRESTORE_LONG_POLLING = import.meta.env.PROD
  && import.meta.env.VITE_FIRESTORE_FORCE_LONG_POLLING !== 'false'
const FIRESTORE_LONG_POLLING_TIMEOUT_SECONDS = 25

/** Share one in-flight/resolved load, but release a rejected Promise so a
 * transient chunk or initialization failure can be retried explicitly.
 * `.reset()` forces the NEXT call to redo `load()` even after a successful
 * resolve — used by reconcileFirestoreOwner to force re-initialization
 * after an account-switch tears down a live instance. */
function retryableLazy<T>(load: () => Promise<T>): (() => Promise<T>) & { reset: () => void } {
  let promise: Promise<T> | null = null
  const fn = (): Promise<T> => {
    if (!promise) {
      promise = load().catch(error => {
        promise = null
        throw error
      })
    }
    return promise
  }
  fn.reset = () => { promise = null }
  return fn
}

const getApp = retryableLazy(async (): Promise<FirebaseApp> => {
  const m = await import('firebase/app')
  return m.getApps().length === 0 ? m.initializeApp(firebaseConfig) : m.getApp()
})

let firestoreEmulatorConnected = false
// True once getFirebase()'s loader has started this page load — lets
// reconcileFirestoreOwner tell "nothing has touched IndexedDB yet" (safe to
// delete the raw databases) from "a live instance may still hold it open"
// (must terminate() first). Reset alongside getFirebase.reset().
let firestoreEverRequested = false

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
 * returns. Init failure is fatal in production (fail-closed — a bad
 * transport setting must not be silently replaced by defaults), but the
 * rejection is never cached: the next call retries. Only dev falls back
 * to getFirestore() defaults (HMR double-init).
 */
export const getFirebase = retryableLazy(async (): Promise<FirebaseBundle> => {
  firestoreEverRequested = true
  const [app, fs] = await Promise.all([getApp(), import('firebase/firestore')])
  // `ignoreUndefinedProperties` lets optional form fields pass through as
  // `undefined` without triggering "Unsupported field value: undefined".
  // A second call on HMR throws; development may reuse the existing instance.
  // Production initialization errors must remain fatal so a bad transport
  // setting cannot be silently replaced by getFirestore() defaults.
  // Targets the auto-created `(default)` database (no third arg).
  let db: Firestore
  try {
    db = fs.initializeFirestore(app, {
      ignoreUndefinedProperties: true,
      ...(FORCE_FIRESTORE_LONG_POLLING && {
        experimentalForceLongPolling: true,
        experimentalLongPollingOptions: {
          timeoutSeconds: FIRESTORE_LONG_POLLING_TIMEOUT_SECONDS,
        },
      }),
      localCache: FIREBASE_EMULATOR_MODE
        ? fs.memoryLocalCache()
        : fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
    })
  } catch (error) {
    if (!import.meta.env.DEV) throw error
    db = fs.getFirestore(app)
  }
  if (FIREBASE_EMULATOR_MODE && !firestoreEmulatorConnected) {
    fs.connectFirestoreEmulator(db, EMULATOR_HOST, EMULATOR_PORTS.firestore)
    firestoreEmulatorConnected = true
  }
  return { db, ...fs }
})

// ─── Firestore IDB account isolation ─────────────────────────────────────────
// `persistentLocalCache` stores documents and pending offline mutations in
// IndexedDB with no per-user scoping. If a different account signs in on the
// same device, the previous account's IDB data (including un-synced writes)
// would still be present — the IDB equivalent of the localStorage leak
// accountScope.ts closes for tripStore/lastViewedStore.
//
// MUST be driven by reconcileAccountScope with the AUTHORITATIVE resolved
// uid, never by a check inside getFirebase() itself: main.tsx's hint-based
// eager warm-up (`if (readAuthHint()) void getFirebase()`) can run before
// the real uid is known — the hint is a boolean set from a PRIOR session,
// unrelated to the uid onAuthStateChanged is about to resolve this session.
// Comparing against tripStore.ownerUid at getFirebase()-call time would read
// a stale value in exactly the cold-start account-switch case this exists
// to catch (an earlier version of this function had that bug).
//
// If Firestore already mounted under the stale account by the time this
// runs, `terminate()` must release its grip on IndexedDB first —
// `clearIndexedDbPersistence()` throws on a still-started instance — then
// `getFirebase.reset()` forces the next call to build a fresh instance
// (`initializeFirestore` is documented as safe to call again post-terminate).
// If Firestore was never touched this page load, no live instance holds the
// databases open, so a direct delete is sufficient and avoids paying for an
// init+teardown neither side needs.
//
// KNOWN LIMITATION (verified by reading the bundled SDK source, not just its
// docs): `clearIndexedDbPersistence()` ultimately calls the bare
// `indexedDB.deleteDatabase()` and only wires `onsuccess`/`onerror` — it does
// NOT handle `onblocked`. A delete request is blocked for as long as ANOTHER
// tab (any account) still holds an open connection to the same database, and
// an unhandled `onblocked` never fires success OR error — the SDK's promise
// simply never settles. `persistentMultipleTabManager()` makes multi-tab a
// supported usage pattern here, so this isn't a purely theoretical case.
// `withTimeout` below prevents that from hanging this function forever; the
// residual risk (a same-name IndexedDB open queued behind a still-blocked
// delete) is accepted rather than solved, since it degrades to "this tab's
// Firestore cache stays uninitialized until the other tab closes" rather
// than data corruption or a security gap — the rules/query-uid boundary
// mentioned above still holds throughout.
const FS_IDB_OWNER_KEY = 'tripmate:fs-idb-owner'
const CLEAR_PERSISTENCE_TIMEOUT_MS = 3_000

function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    p.then(
      () => { clearTimeout(timer); resolve() },
      e => { clearTimeout(timer); reject(e) },
    )
  })
}

async function deleteFirestoreIdbDatabases(): Promise<void> {
  if (typeof indexedDB === 'undefined' || !('databases' in indexedDB)) return
  const dbs = await indexedDB.databases()
  await Promise.all(
    dbs
      .filter(d => d.name?.startsWith('firestore'))
      .map(d => new Promise<void>(ok => {
        const r = indexedDB.deleteDatabase(d.name!)
        r.onsuccess = r.onerror = r.onblocked = () => ok()
      })),
  )
}

/** Reconcile Firestore's IndexedDB persistence against the account that just
 * resolved. Called from reconcileAccountScope — best-effort and non-fatal;
 * Firestore security rules and query-level uid filtering remain the
 * authoritative access boundary regardless of whether this succeeds. */
export async function reconcileFirestoreOwner(uid: string): Promise<void> {
  if (typeof window === 'undefined' || FIREBASE_EMULATOR_MODE) return
  try {
    const storedOwner = localStorage.getItem(FS_IDB_OWNER_KEY)
    if (storedOwner === uid) return

    if (storedOwner !== null) {
      if (firestoreEverRequested) {
        const bundle = await getFirebase()
        await bundle.terminate(bundle.db)
        try {
          await withTimeout(bundle.clearIndexedDbPersistence(bundle.db), CLEAR_PERSISTENCE_TIMEOUT_MS)
        } catch (e) {
          // Likely another tab still has the database open (onblocked never
          // settles the SDK's promise) — see the limitation note above.
          // Non-fatal: still reset so the next getFirebase() builds a fresh
          // instance rather than reusing the terminated one.
          captureError(e, { source: 'reconcileFirestoreOwner:clearIndexedDbPersistence' })
        }
        getFirebase.reset()
        firestoreEverRequested = false
      } else {
        await deleteFirestoreIdbDatabases()
      }
    }
    localStorage.setItem(FS_IDB_OWNER_KEY, uid)
  } catch (e) {
    captureError(e, { source: 'reconcileFirestoreOwner' })
  }
}

let authEmulatorConnected = false

/**
 * Lazy-load + initialize the Auth bundle. Kept separate from the Firestore
 * bundle so demo-mode pages that only read mocks don't pull ~40KB gz of
 * auth code. Callers should gate subscription on `!isDemo`.
 */
export const getFirebaseAuth = retryableLazy(async (): Promise<AuthBundle> => {
  const [app, authMod] = await Promise.all([getApp(), import('firebase/auth')])
  const auth = authMod.getAuth(app)
  if (FIREBASE_EMULATOR_MODE && !authEmulatorConnected) {
    authMod.connectAuthEmulator(auth, `http://${EMULATOR_HOST}:${EMULATOR_PORTS.auth}`, { disableWarnings: true })
    authEmulatorConnected = true
  }
  return { auth, ...authMod }
})

/**
 * Lazy-load + initialize the Messaging bundle for FCM Web Push. Resolves
 * `null` when the browser can't do Web Push (`isSupported()` false — e.g.
 * Safari tab without Home-Screen install, private mode) so callers branch
 * instead of crashing. Pulled separately from Firestore/Auth/Storage and
 * loaded ONLY from the Account notification toggle (`enable()`) or the
 * foreground listener (both gate on signed-in + permission granted), so
 * demo / signed-out / never-opted-in sessions ship zero messaging code.
 */
export const getFirebaseMessaging = retryableLazy(async (): Promise<MessagingBundle | null> => {
  const [app, msg] = await Promise.all([getApp(), import('firebase/messaging')])
  const supported = await msg.isSupported().catch(() => false)
  if (!supported) return null
  return { messaging: msg.getMessaging(app), ...msg }
})

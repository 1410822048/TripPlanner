import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const FS_IDB_OWNER_KEY = 'tripmate:fs-idb-owner'

const firebaseMocks = vi.hoisted(() => {
  const app = { name: '[DEFAULT]' }
  const db = { type: 'firestore' }
  return {
    app,
    db,
    getApps: vi.fn(() => [] as unknown[]),
    initializeApp: vi.fn(() => app),
    getApp: vi.fn(() => app),
    initializeFirestore: vi.fn(() => db),
    getFirestore: vi.fn(() => db),
    memoryLocalCache: vi.fn(() => ({ kind: 'memory' })),
    persistentLocalCache: vi.fn((options: unknown) => ({ kind: 'persistent', options })),
    persistentMultipleTabManager: vi.fn(() => ({ kind: 'multi-tab' })),
    terminate: vi.fn(() => Promise.resolve()),
    clearIndexedDbPersistence: vi.fn(() => Promise.resolve()),
  }
})

vi.mock('firebase/app', () => ({
  getApps: firebaseMocks.getApps,
  initializeApp: firebaseMocks.initializeApp,
  getApp: firebaseMocks.getApp,
}))

vi.mock('firebase/firestore', () => ({
  initializeFirestore: firebaseMocks.initializeFirestore,
  getFirestore: firebaseMocks.getFirestore,
  memoryLocalCache: firebaseMocks.memoryLocalCache,
  persistentLocalCache: firebaseMocks.persistentLocalCache,
  persistentMultipleTabManager: firebaseMocks.persistentMultipleTabManager,
  terminate: firebaseMocks.terminate,
  clearIndexedDbPersistence: firebaseMocks.clearIndexedDbPersistence,
}))

const REQUIRED_PROD_ENV = {
  VITE_FIREBASE_API_KEY: 'test-api-key',
  VITE_FIREBASE_AUTH_DOMAIN: 'tripmate.example.test',
  VITE_FIREBASE_PROJECT_ID: 'test-project',
  VITE_FIREBASE_MESSAGING_SENDER_ID: '123456789',
  VITE_FIREBASE_VAPID_KEY: 'test-vapid-key',
  VITE_FIREBASE_APP_ID: '1:123456789:web:test',
} as const

function stubProductionEnv(forceLongPolling?: string) {
  vi.stubEnv('PROD', true)
  vi.stubEnv('DEV', false)
  for (const [key, value] of Object.entries(REQUIRED_PROD_ENV)) {
    vi.stubEnv(key, value)
  }
  if (forceLongPolling !== undefined) {
    vi.stubEnv('VITE_FIRESTORE_FORCE_LONG_POLLING', forceLongPolling)
  }
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  firebaseMocks.getApps.mockReturnValue([])
  firebaseMocks.initializeFirestore.mockReturnValue(firebaseMocks.db)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('getFirebase transport initialization', () => {
  it('uses bounded long-polling by default in production', async () => {
    stubProductionEnv()

    const { getFirebase } = await import('./firebase')
    await getFirebase()

    expect(firebaseMocks.initializeFirestore).toHaveBeenCalledWith(
      firebaseMocks.app,
      expect.objectContaining({
        experimentalForceLongPolling: true,
        experimentalLongPollingOptions: { timeoutSeconds: 25 },
      }),
    )
  })

  it('allows production to return to SDK transport auto-detection', async () => {
    stubProductionEnv('false')

    const { getFirebase } = await import('./firebase')
    await getFirebase()

    expect(firebaseMocks.initializeFirestore).toHaveBeenCalledWith(
      firebaseMocks.app,
      expect.not.objectContaining({ experimentalForceLongPolling: expect.anything() }),
    )
    expect(firebaseMocks.initializeFirestore).toHaveBeenCalledWith(
      firebaseMocks.app,
      expect.not.objectContaining({ experimentalLongPollingOptions: expect.anything() }),
    )
  })

  it('does not silently replace a production initialization failure', async () => {
    stubProductionEnv()
    firebaseMocks.initializeFirestore.mockImplementationOnce(() => {
      throw new Error('transport init failed')
    })

    const { getFirebase } = await import('./firebase')

    await expect(getFirebase()).rejects.toThrow('transport init failed')
    expect(firebaseMocks.getFirestore).not.toHaveBeenCalled()
  })

  it('retries after a transient failure instead of caching the rejection', async () => {
    stubProductionEnv()
    firebaseMocks.initializeFirestore.mockImplementationOnce(() => {
      throw new Error('transient init failure')
    })

    const { getFirebase } = await import('./firebase')

    await expect(getFirebase()).rejects.toThrow('transient init failure')

    const bundle = await getFirebase()
    expect(bundle.db).toBe(firebaseMocks.db)
    expect(firebaseMocks.initializeFirestore).toHaveBeenCalledTimes(2)
  })

  it('deduplicates concurrent initialization with the same in-flight Promise', async () => {
    stubProductionEnv()

    const { getFirebase } = await import('./firebase')
    const first = getFirebase()
    const second = getFirebase()

    expect(second).toBe(first)
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(firebaseMocks.initializeFirestore).toHaveBeenCalledTimes(1)
  })
})

// ─── Firestore IDB account isolation ─────────────────────────────────────────
// `reconcileFirestoreOwner` is called from reconcileAccountScope with the
// AUTHORITATIVE resolved uid — NOT checked inside getFirebase() itself, since
// main.tsx's hint-based eager warm-up can call getFirebase() before the real
// uid is known (see the comment in firebase.ts for the cold-start race an
// earlier version of this had).

describe('reconcileFirestoreOwner', () => {
  let deletedDbs: string[]
  let databasesResult: { name: string; version: number }[]

  beforeEach(() => {
    deletedDbs = []
    databasesResult = []
    Object.defineProperty(window, 'indexedDB', {
      value: {
        databases: vi.fn(() => Promise.resolve(databasesResult)),
        deleteDatabase: vi.fn((name: string) => {
          deletedDbs.push(name)
          const req = { onsuccess: null as (() => void) | null, onerror: null, onblocked: null }
          setTimeout(() => { if (req.onsuccess) req.onsuccess() }, 0)
          return req
        }),
      } as unknown as IDBFactory,
      writable: true,
      configurable: true,
    })
  })

  it('deletes firestore IDB databases directly when Firestore was never requested this page load', async () => {
    window.localStorage.setItem(FS_IDB_OWNER_KEY, 'uid-a')
    databasesResult = [
      { name: 'firestore/[DEFAULT]/test-project/(default)', version: 1 },
      { name: 'firestore_mutations/[DEFAULT]/test-project', version: 1 },
      { name: 'unrelated-db', version: 1 },
    ]

    stubProductionEnv()
    const { reconcileFirestoreOwner } = await import('./firebase')
    await reconcileFirestoreOwner('uid-b')

    // Only the firestore-prefixed databases should be deleted
    expect(deletedDbs).toEqual([
      'firestore/[DEFAULT]/test-project/(default)',
      'firestore_mutations/[DEFAULT]/test-project',
    ])
    expect(window.localStorage.getItem(FS_IDB_OWNER_KEY)).toBe('uid-b')
    // No live instance was ever requested — must not pay for an init+teardown.
    expect(firebaseMocks.initializeFirestore).not.toHaveBeenCalled()
    expect(firebaseMocks.terminate).not.toHaveBeenCalled()
  })

  it('terminates + clears via the SDK when Firestore already mounted under the stale account (eager warm-up race)', async () => {
    window.localStorage.setItem(FS_IDB_OWNER_KEY, 'uid-a')
    stubProductionEnv()
    const { getFirebase, reconcileFirestoreOwner } = await import('./firebase')

    // Simulate main.tsx's hint-based eager warm-up already having mounted
    // Firestore under the stale account BEFORE the authoritative uid (uid-b)
    // is known.
    await getFirebase()
    expect(firebaseMocks.initializeFirestore).toHaveBeenCalledTimes(1)

    await reconcileFirestoreOwner('uid-b')

    expect(firebaseMocks.terminate).toHaveBeenCalledWith(firebaseMocks.db)
    expect(firebaseMocks.clearIndexedDbPersistence).toHaveBeenCalledWith(firebaseMocks.db)
    // Raw indexedDB deletion is NOT used on this path — the SDK's own
    // lifecycle functions own the cleanup once a live instance exists.
    expect(deletedDbs).toHaveLength(0)
    expect(window.localStorage.getItem(FS_IDB_OWNER_KEY)).toBe('uid-b')

    // getFirebase.reset() must force the NEXT call to re-initialize.
    await getFirebase()
    expect(firebaseMocks.initializeFirestore).toHaveBeenCalledTimes(2)
  })

  it('does not hang forever when clearIndexedDbPersistence is blocked by another tab', async () => {
    // The bundled SDK's clearIndexedDbPersistence only wires onsuccess/onerror
    // on the underlying indexedDB.deleteDatabase() request — onblocked (fired
    // while another tab still holds the database open) never settles its
    // promise. Simulated here as a promise that never resolves.
    window.localStorage.setItem(FS_IDB_OWNER_KEY, 'uid-a')
    stubProductionEnv()
    const { getFirebase, reconcileFirestoreOwner } = await import('./firebase')
    await getFirebase()
    firebaseMocks.clearIndexedDbPersistence.mockReturnValueOnce(new Promise(() => {}))

    vi.useFakeTimers()
    try {
      const pending = reconcileFirestoreOwner('uid-b')
      await vi.advanceTimersByTimeAsync(3_000)
      await pending
    } finally {
      vi.useRealTimers()
    }

    // Recovers anyway: still resets (next call gets a fresh instance) and
    // still claims the incoming owner instead of hanging mid-reconcile.
    expect(window.localStorage.getItem(FS_IDB_OWNER_KEY)).toBe('uid-b')
    await getFirebase()
    expect(firebaseMocks.initializeFirestore).toHaveBeenCalledTimes(2)
  })

  it('is a no-op when the stored owner already matches', async () => {
    window.localStorage.setItem(FS_IDB_OWNER_KEY, 'uid-a')

    stubProductionEnv()
    const { reconcileFirestoreOwner } = await import('./firebase')
    await reconcileFirestoreOwner('uid-a')

    expect(deletedDbs).toHaveLength(0)
    expect(firebaseMocks.terminate).not.toHaveBeenCalled()
  })

  it('claims the owner without deleting anything on first-ever initialization (no stored owner)', async () => {
    stubProductionEnv()
    const { reconcileFirestoreOwner } = await import('./firebase')
    await reconcileFirestoreOwner('uid-a')

    expect(deletedDbs).toHaveLength(0)
    expect(firebaseMocks.terminate).not.toHaveBeenCalled()
    expect(window.localStorage.getItem(FS_IDB_OWNER_KEY)).toBe('uid-a')
  })
})

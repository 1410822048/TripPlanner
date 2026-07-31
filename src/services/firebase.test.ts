import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
})

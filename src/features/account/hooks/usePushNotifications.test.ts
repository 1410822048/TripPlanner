import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const messagingBundle = vi.hoisted(() => ({
  messaging: {},
  getToken: vi.fn(),
}))

const pushTokenService = vi.hoisted(() => ({
  announcePushTokenEnabled: vi.fn(),
  disableStoredPushToken: vi.fn(),
  isTokenEnabled: vi.fn(),
  readStoredPushTokenHash: vi.fn(() => null),
  saveToken: vi.fn(async () => 'token-hash'),
  writeStoredPushTokenHash: vi.fn(),
}))

vi.mock('@/services/firebase', () => ({
  getFirebaseMessaging: vi.fn(async () => messagingBundle),
}))

vi.mock('../services/pushTokenService', () => pushTokenService)

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('VITE_FIREBASE_VAPID_KEY', 'test-vapid-key')
  vi.stubGlobal('Notification', {
    permission: 'default',
    requestPermission: vi.fn(async () => 'granted' as NotificationPermission),
  })
  vi.stubGlobal('PushManager', function PushManager() {})
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { ready: Promise.resolve({ scope: '/' }) },
  })
  messagingBundle.getToken.mockReset()
  pushTokenService.announcePushTokenEnabled.mockClear()
  pushTokenService.disableStoredPushToken.mockClear()
  pushTokenService.isTokenEnabled.mockClear()
  pushTokenService.readStoredPushTokenHash.mockClear()
  pushTokenService.readStoredPushTokenHash.mockReturnValue(null)
  pushTokenService.saveToken.mockClear()
  pushTokenService.saveToken.mockResolvedValue('token-hash')
  pushTokenService.writeStoredPushTokenHash.mockClear()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

test('does not save a push token after the signed-in uid is gone', async () => {
  let resolveToken!: (token: string) => void
  const tokenStarted = new Promise<void>(resolve => {
    messagingBundle.getToken.mockImplementationOnce(() => {
      resolve()
      return new Promise<string>(done => { resolveToken = done })
    })
  })
  const { usePushNotifications } = await import('./usePushNotifications')
  const hook = renderHook(
    ({ uid }: { uid: string | undefined }) => usePushNotifications(uid),
    { initialProps: { uid: 'user-1' as string | undefined } },
  )
  await waitFor(() => expect(hook.result.current.support).toBe('supported'))

  let enablePromise!: Promise<void>
  await act(async () => {
    enablePromise = hook.result.current.enable()
  })
  await tokenStarted

  hook.rerender({ uid: undefined })
  resolveToken('fcm-token-after-signout')
  await act(async () => { await enablePromise })

  expect(pushTokenService.saveToken).not.toHaveBeenCalled()
  expect(pushTokenService.writeStoredPushTokenHash).not.toHaveBeenCalled()
})

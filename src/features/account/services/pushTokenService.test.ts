// Pins sha256Hex against a known vector + stability. The token CRUD fns
// hit Firestore (covered by rules tests + manual QA), but the hash is pure
// and load-bearing: it's the pushTokens doc id, so a drift here would
// silently fork every device into a fresh token doc.
import { beforeEach, describe, expect, test, vi } from 'vitest'

const fb = vi.hoisted(() => ({
  db: {},
  doc:             vi.fn(() => 'token-ref'),
  getDoc:          vi.fn(),
  setDoc:          vi.fn(),
  updateDoc:       vi.fn(),
  serverTimestamp: vi.fn(() => 'server-timestamp'),
  deleteField:     vi.fn(() => 'delete-field'),
}))
const msg = vi.hoisted(() => ({
  messaging:    {},
  deleteToken:  vi.fn(),
}))

vi.mock('@/services/firebase', () => ({
  getFirebase:          vi.fn(async () => fb),
  getFirebaseMessaging: vi.fn(async () => msg),
}))

import {
  disableStoredPushToken,
  revokeStoredPushToken,
  saveToken,
  sha256Hex,
  writeStoredPushTokenHash,
} from './pushTokenService'

beforeEach(() => {
  vi.stubGlobal('__APP_VERSION__', 'test-version')
  vi.stubGlobal('Notification', { permission: 'default' })
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem:    vi.fn((key: string) => storage.get(key) ?? null),
    setItem:    vi.fn((key: string, value: string) => { storage.set(key, value) }),
    removeItem: vi.fn((key: string) => { storage.delete(key) }),
    clear:      vi.fn(() => { storage.clear() }),
  })
  fb.doc.mockClear()
  fb.getDoc.mockReset()
  fb.setDoc.mockReset()
  fb.updateDoc.mockReset()
  fb.serverTimestamp.mockClear()
  fb.deleteField.mockClear()
  msg.deleteToken.mockReset()
})

describe('sha256Hex', () => {
  test('matches the known SHA-256 vector for "abc"', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  test('is deterministic and 64 hex chars', async () => {
    const a = await sha256Hex('fcm-token-xyz')
    const b = await sha256Hex('fcm-token-xyz')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('saveToken', () => {
  test('re-enables an existing disabled same-device token', async () => {
    fb.getDoc.mockResolvedValue({
      exists: () => true,
      data:   () => ({ disabledAt: { seconds: 1 }, disabledReason: 'user-disabled' }),
    })

    await saveToken({ uid: 'user-1', token: 'fcm-token-xyz', swScope: '/' })

    expect(fb.setDoc).not.toHaveBeenCalled()
    expect(fb.updateDoc).toHaveBeenCalledWith('token-ref', {
      updatedAt:      'server-timestamp',
      lastSeenAt:     'server-timestamp',
      appVersion:     'test-version',
      disabledAt:     null,
      disabledReason: 'delete-field',
    })
  })

  test('refreshes an enabled existing token without touching disabled fields', async () => {
    fb.getDoc.mockResolvedValue({
      exists: () => true,
      data:   () => ({ disabledAt: null }),
    })

    await saveToken({ uid: 'user-1', token: 'fcm-token-xyz', swScope: '/' })

    expect(fb.updateDoc).toHaveBeenCalledWith('token-ref', {
      updatedAt:  'server-timestamp',
      lastSeenAt: 'server-timestamp',
      appVersion: 'test-version',
    })
  })

  test('rotates away from a server-disabled token instead of re-enabling it', async () => {
    // First read: the dead doc. Second read (fresh token hash): absent.
    fb.getDoc
      .mockResolvedValueOnce({ exists: () => true, data: () => ({ disabledAt: { seconds: 1 }, disabledReason: 'fcm-unregistered' }) })
      .mockResolvedValueOnce({ exists: () => false, data: () => null })
    const rotateToken = vi.fn(async () => 'fresh-fcm-token')

    await saveToken({ uid: 'user-1', token: 'dead-fcm-token', swScope: '/', rotateToken })

    expect(rotateToken).toHaveBeenCalledOnce()
    expect(fb.setDoc).toHaveBeenCalledOnce()     // fresh token written via create path
    expect(fb.updateDoc).not.toHaveBeenCalled()  // the dead doc was never re-enabled
  })

  test('refuses to resurrect a server-disabled token without a rotator', async () => {
    fb.getDoc.mockResolvedValueOnce({ exists: () => true, data: () => ({ disabledAt: { seconds: 1 }, disabledReason: 'send-failed' }) })

    await expect(saveToken({ uid: 'user-1', token: 'dead-fcm-token', swScope: '/' })).rejects.toThrow()
    expect(fb.updateDoc).not.toHaveBeenCalled()
    expect(fb.setDoc).not.toHaveBeenCalled()
  })
})

describe('disableStoredPushToken', () => {
  test('disables the current stored device token', async () => {
    const tokenHash = 'a'.repeat(64)
    writeStoredPushTokenHash(tokenHash)

    await disableStoredPushToken('user-1')

    expect(fb.doc).toHaveBeenCalledWith(fb.db, 'users', 'user-1', 'pushTokens', tokenHash)
    expect(fb.updateDoc).toHaveBeenCalledWith('token-ref', {
      disabledAt:     'server-timestamp',
      disabledReason: 'user-disabled',
      updatedAt:      'server-timestamp',
    })
    expect(localStorage.getItem('tripmate.push.tokenHash')).toBeNull()
  })

  test('uses permission-revoked when the OS/browser permission was removed', async () => {
    const tokenHash = 'b'.repeat(64)
    writeStoredPushTokenHash(tokenHash)

    await disableStoredPushToken('user-1', 'permission-revoked')

    expect(fb.updateDoc).toHaveBeenCalledWith('token-ref', {
      disabledAt:     'server-timestamp',
      disabledReason: 'permission-revoked',
      updatedAt:      'server-timestamp',
    })
    expect(localStorage.getItem('tripmate.push.tokenHash')).toBeNull()
  })

  test('keeps the local token hint when the disable write fails', async () => {
    writeStoredPushTokenHash('a'.repeat(64))
    fb.updateDoc.mockRejectedValueOnce(new Error('offline'))

    await expect(disableStoredPushToken('user-1')).rejects.toThrow('offline')

    expect(localStorage.getItem('tripmate.push.tokenHash')).toBe('a'.repeat(64))
  })

  test('does not clear a newer local token hint after an older disable finishes', async () => {
    const oldHash = 'a'.repeat(64)
    const newHash = 'b'.repeat(64)
    let finishDisable!: () => void
    const disableStarted = new Promise<void>(resolve => {
      fb.updateDoc.mockImplementationOnce(() => {
        resolve()
        return new Promise<void>(done => { finishDisable = done })
      })
    })
    writeStoredPushTokenHash(oldHash)

    const disablePromise = disableStoredPushToken('user-1')
    await disableStarted
    writeStoredPushTokenHash(newHash)
    finishDisable()
    await disablePromise

    expect(localStorage.getItem('tripmate.push.tokenHash')).toBe(newHash)
  })
})

describe('revokeStoredPushToken', () => {
  test('skips browser token deletion without a local hash when notification permission is not granted', async () => {
    await revokeStoredPushToken('user-1')

    expect(fb.updateDoc).not.toHaveBeenCalled()
    expect(msg.deleteToken).not.toHaveBeenCalled()
  })

  test('deletes the browser FCM token even when the local token hash is missing', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' })
    msg.deleteToken.mockResolvedValueOnce(false)

    await revokeStoredPushToken('user-1')

    expect(fb.updateDoc).not.toHaveBeenCalled()
    expect(msg.deleteToken).toHaveBeenCalledWith(msg.messaging)
    expect(localStorage.getItem('tripmate.push.tokenHash')).toBeNull()
  })

  test('fails revoke without a local hash when browser token deletion fails', async () => {
    vi.stubGlobal('Notification', { permission: 'granted' })
    msg.deleteToken.mockRejectedValueOnce(new Error('chunk failed'))

    await expect(revokeStoredPushToken('user-1')).rejects.toThrow('通知トークンを解除できませんでした')

    expect(fb.updateDoc).not.toHaveBeenCalled()
  })

  test('clears local token hint when server disable succeeds', async () => {
    writeStoredPushTokenHash('a'.repeat(64))
    msg.deleteToken.mockResolvedValueOnce(false)

    await revokeStoredPushToken('user-1')

    expect(fb.updateDoc).toHaveBeenCalledWith('token-ref', {
      disabledAt:     'server-timestamp',
      disabledReason: 'user-disabled',
      updatedAt:      'server-timestamp',
    })
    expect(msg.deleteToken).toHaveBeenCalledWith(msg.messaging)
    expect(localStorage.getItem('tripmate.push.tokenHash')).toBeNull()
  })

  test('fails revoke when server disable fails even if the browser token was deleted', async () => {
    writeStoredPushTokenHash('a'.repeat(64))
    fb.updateDoc.mockRejectedValueOnce(new Error('offline'))
    msg.deleteToken.mockResolvedValueOnce(true)

    // Delivery is gated server-side on the doc staying enabled, so a failed
    // server disable means the token is still live — a successful browser
    // delete must NOT mask that. Surface it + keep the hint for a retry.
    await expect(revokeStoredPushToken('user-1')).rejects.toThrow('通知トークンを解除できませんでした')
    expect(localStorage.getItem('tripmate.push.tokenHash')).toBe('a'.repeat(64))
  })

  test('keeps local token hint when both revoke paths fail', async () => {
    writeStoredPushTokenHash('a'.repeat(64))
    fb.updateDoc.mockRejectedValueOnce(new Error('offline'))
    msg.deleteToken.mockRejectedValueOnce(new Error('chunk failed'))

    await expect(revokeStoredPushToken('user-1')).rejects.toThrow('通知トークンを解除できませんでした')

    expect(localStorage.getItem('tripmate.push.tokenHash')).toBe('a'.repeat(64))
  })

  test('does not clear a newer local token hint after an older revoke finishes', async () => {
    const oldHash = 'a'.repeat(64)
    const newHash = 'b'.repeat(64)
    let finishDisable!: () => void
    const disableStarted = new Promise<void>(resolve => {
      fb.updateDoc.mockImplementationOnce(() => {
        resolve()
        return new Promise<void>(done => { finishDisable = done })
      })
    })
    msg.deleteToken.mockResolvedValueOnce(false)
    writeStoredPushTokenHash(oldHash)

    const revokePromise = revokeStoredPushToken('user-1')
    await disableStarted
    writeStoredPushTokenHash(newHash)
    finishDisable()
    await revokePromise

    expect(localStorage.getItem('tripmate.push.tokenHash')).toBe(newHash)
  })
})

import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { NormalizedPushEvent } from '../model.js'

const messagingMock = vi.hoisted(() => ({
  sendEach: vi.fn(),
}))
const firestoreMock = vi.hoisted(() => {
  const tokenDoc = { update: vi.fn() }
  const doc = vi.fn(() => tokenDoc)
  return {
    tokenDoc,
    doc,
    getFirestore: vi.fn(() => ({ doc })),
  }
})

vi.mock('firebase-admin/messaging', () => ({
  getMessaging: vi.fn(() => messagingMock),
}))

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: firestoreMock.getFirestore,
  FieldValue: {
    serverTimestamp: vi.fn(() => 'server-timestamp'),
  },
}))

import { chunk, isInvalidTokenCode, isRetryableSendErrorCode, sendPush } from '../send.js'

function pushEvent(): NormalizedPushEvent {
  return {
    eventId:     'event-1',
    tripId:      'trip-1',
    entityType:  'expense',
    entityId:    'expense-1',
    action:      'created',
    actorUid:    'actor-1',
    route:       '/expense',
    templateKey: 'expense.created',
  }
}

beforeEach(() => {
  messagingMock.sendEach.mockReset()
  firestoreMock.doc.mockClear()
  firestoreMock.tokenDoc.update.mockReset()
})

describe('send helpers', () => {
  test('chunks multicast sends at the FCM-safe boundary', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  test('classifies token cleanup errors', () => {
    expect(isInvalidTokenCode('messaging/registration-token-not-registered')).toBe(true)
    expect(isInvalidTokenCode('messaging/invalid-registration-token')).toBe(true)
    expect(isInvalidTokenCode('messaging/invalid-argument')).toBe(true)
    expect(isInvalidTokenCode('messaging/unavailable')).toBe(false)
  })

  test('classifies retryable FCM send errors', () => {
    expect(isRetryableSendErrorCode('messaging/unavailable')).toBe(true)
    expect(isRetryableSendErrorCode('messaging/internal-error')).toBe(true)
    expect(isRetryableSendErrorCode('messaging/registration-token-not-registered')).toBe(false)
    expect(isRetryableSendErrorCode('messaging/invalid-argument')).toBe(false)
  })

  test('sends one owner-scoped payload per token without increasing batch count', async () => {
    messagingMock.sendEach.mockResolvedValueOnce({
      successCount: 2,
      failureCount: 0,
      responses:    [{ success: true }, { success: true }],
    })

    const result = await sendPush(pushEvent(), [
      { uid: 'user-1', tokenHash: 'hash-1', token: 'token-1' },
      { uid: 'user-2', tokenHash: 'hash-2', token: 'token-2' },
    ])

    expect(result).toEqual({ sentCount: 2, failedCount: 0, errorCodes: {} })
    expect(messagingMock.sendEach).toHaveBeenCalledOnce()
    expect(messagingMock.sendEach).toHaveBeenCalledWith([
      expect.objectContaining({
        token: 'token-1',
        data:  expect.objectContaining({ targetUid: 'user-1', eventId: 'event-1' }),
      }),
      expect.objectContaining({
        token: 'token-2',
        data:  expect.objectContaining({ targetUid: 'user-2', eventId: 'event-1' }),
      }),
    ])
  })

  test('cleans up the matching invalid token after per-message sends', async () => {
    messagingMock.sendEach.mockResolvedValueOnce({
      successCount: 1,
      failureCount: 1,
      responses: [
        { success: false, error: { code: 'messaging/registration-token-not-registered' } },
        { success: true },
      ],
    })

    await sendPush(pushEvent(), [
      { uid: 'user-1', tokenHash: 'hash-1', token: 'token-1' },
      { uid: 'user-2', tokenHash: 'hash-2', token: 'token-2' },
    ])

    expect(firestoreMock.doc).toHaveBeenCalledWith('users/user-1/pushTokens/hash-1')
    expect(firestoreMock.doc).not.toHaveBeenCalledWith('users/user-2/pushTokens/hash-2')
    expect(firestoreMock.tokenDoc.update).toHaveBeenCalledWith({
      disabledAt:     'server-timestamp',
      disabledReason: 'fcm-unregistered',
      updatedAt:      'server-timestamp',
    })
  })
})

import { beforeEach, describe, expect, test, vi } from 'vitest'

const firestoreMock = vi.hoisted(() => {
  const docData = new Map<string, Record<string, unknown> | undefined>()
  const txGet = vi.fn(async (ref: { __path: string }) => snapshotFor(ref.__path))
  const txCreate = vi.fn()

  function snapshotFor(path: string) {
    return {
      exists: docData.has(path),
      get: (field: string) => docData.get(path)?.[field],
    }
  }

  const db = {
    doc: vi.fn((path: string) => ({
      __path: path,
      get: vi.fn(async () => snapshotFor(path)),
    })),
    runTransaction: vi.fn(async (fn: (tx: { get: typeof txGet; create: typeof txCreate }) => unknown) => fn({
      get:    txGet,
      create: txCreate,
    })),
  }
  return {
    db, docData, txGet, txCreate,
    getFirestore: vi.fn(() => db),
  }
})

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: firestoreMock.getFirestore,
  FieldValue: { serverTimestamp: vi.fn(() => 'server-timestamp') },
  Timestamp: { fromMillis: vi.fn((ms: number) => ({ toMillis: () => ms })) },
}))

import { writeNotificationDocs, NOTIFICATION_RETENTION_MS } from '../notifications.js'
import type { NormalizedPushEvent } from '../model.js'

beforeEach(() => {
  firestoreMock.docData.clear()
  firestoreMock.db.doc.mockClear()
  firestoreMock.db.runTransaction.mockClear()
  firestoreMock.txGet.mockClear()
  firestoreMock.txCreate.mockClear()
})

function baseEvent(overrides: Partial<NormalizedPushEvent> = {}): NormalizedPushEvent {
  return {
    eventId: 'evt-1',
    tripId: 'trip-1',
    entityType: 'expense',
    entityId: 'expense-1',
    action: 'created',
    actorUid: 'actor-1',
    route: '/expense',
    templateKey: 'expense.created',
    ...overrides,
  }
}

describe('writeNotificationDocs', () => {
  test('no-ops when there are no recipients (no batch is even opened)', async () => {
    await writeNotificationDocs(baseEvent(), [])
    expect(firestoreMock.db.runTransaction).not.toHaveBeenCalled()
  })

  test('chunks more than 500 recipients instead of failing the whole dispatch', async () => {
    const recipients = Array.from({ length: 501 }, (_, i) => `u${i}`)

    await writeNotificationDocs(baseEvent(), recipients)

    expect(firestoreMock.db.runTransaction).toHaveBeenCalledTimes(2)
    expect(firestoreMock.txCreate).toHaveBeenCalledTimes(501)
    expect(firestoreMock.txCreate.mock.calls[500]?.[0].__path).toBe('users/u500/notifications/evt-1')
  })

  test('writes one doc per recipient, falling back to a generic name when the member doc is missing', async () => {
    firestoreMock.docData.set('trips/trip-1', { title: 'Tokyo Trip' })

    await writeNotificationDocs(baseEvent(), ['u1', 'u2'])

    expect(firestoreMock.txCreate).toHaveBeenCalledTimes(2)
    const [, doc1] = firestoreMock.txCreate.mock.calls[0]!
    expect(doc1).toMatchObject({
      recipientUid: 'u1',
      tripId: 'trip-1',
      tripTitle: 'Tokyo Trip',
      actorName: 'メンバー',
      title: '費用が追加されました',
      body: 'メンバーさんが費用を追加しました',
      route: '/expense',
      readAt: null,
    })
    expect(doc1.settlement).toBeUndefined()
    expect(firestoreMock.db.runTransaction).toHaveBeenCalledTimes(1)
  })

  // The bug this guards against: a Cloud Functions platform retry re-runs
  // dispatchPushEvent (e.g. the FCM send step failed retryably AFTER this
  // already committed once). A blind overwrite would stamp readAt: null
  // back over a doc the recipient already opened between attempts.
  test('never rewrites a recipient doc that already exists — a retry cannot clobber a readAt the recipient already set', async () => {
    firestoreMock.docData.set('trips/trip-1', { title: 'Tokyo Trip' })
    firestoreMock.docData.set('users/u1/notifications/evt-1', { readAt: { toMillis: () => 123 } })

    await writeNotificationDocs(baseEvent(), ['u1', 'u2'])

    // Only u2 (missing) gets written; u1's already-read doc is left alone.
    expect(firestoreMock.txCreate).toHaveBeenCalledTimes(1)
    const [ref] = firestoreMock.txCreate.mock.calls[0]!
    expect(ref.__path).toBe('users/u2/notifications/evt-1')
  })

  test('does not create anything when every recipient already has a doc', async () => {
    firestoreMock.docData.set('users/u1/notifications/evt-1', {})

    await writeNotificationDocs(baseEvent(), ['u1'])

    expect(firestoreMock.txCreate).not.toHaveBeenCalled()
    expect(firestoreMock.db.runTransaction).toHaveBeenCalledTimes(1)
  })

  test('composes a direction + amount body for settlement events from resolved member names', async () => {
    firestoreMock.docData.set('trips/trip-1/members/actor-1', { displayName: '佐藤' })
    firestoreMock.docData.set('trips/trip-1/members/from-1', { displayName: '田中' })
    firestoreMock.docData.set('trips/trip-1/members/to-1', { displayName: '佐藤' })

    await writeNotificationDocs(baseEvent({
      entityType: 'settlement',
      entityId: 'settlement-1',
      action: 'deleted',
      templateKey: 'settlement.deleted',
      settlement: { fromUid: 'from-1', toUid: 'to-1', amountMinor: 500000, currency: 'JPY' },
    }), ['to-1'])

    const [, doc] = firestoreMock.txCreate.mock.calls[0]!
    expect(doc.body).toBe('佐藤さんが 田中さん → 佐藤さん の ¥500,000 を取り消しました')
    expect(doc.settlement).toEqual({
      fromUid: 'from-1', fromName: '田中', toUid: 'to-1', toName: '佐藤',
      amountMinor: 500000, currency: 'JPY',
    })
  })

  test('writes a fallback settlement body when settlement metadata is missing', async () => {
    firestoreMock.docData.set('trips/trip-1/members/actor-1', { displayName: '佐藤' })

    await writeNotificationDocs(baseEvent({
      entityType: 'settlement',
      entityId: 'settlement-1',
      action: 'deleted',
      templateKey: 'settlement.deleted',
    }), ['to-1'])

    const [, doc] = firestoreMock.txCreate.mock.calls[0]!
    expect(doc.body).toBe('佐藤さんが清算記録を取り消しました')
    expect(doc.settlement).toBeUndefined()
  })

  test('formats a non-JPY amount using the app fraction digits table', async () => {
    await writeNotificationDocs(baseEvent({
      entityType: 'settlement',
      action: 'created',
      templateKey: 'settlement.created',
      settlement: { fromUid: 'from-1', toUid: 'to-1', amountMinor: 5000, currency: 'USD' },
    }), ['to-1'])

    const [, doc] = firestoreMock.txCreate.mock.calls[0]!
    expect(doc.body).toContain('USD 50.00')
  })

  test('keeps app-specific zero-decimal currencies aligned with fx-core', async () => {
    await writeNotificationDocs(baseEvent({
      entityType: 'settlement',
      action: 'created',
      templateKey: 'settlement.created',
      settlement: { fromUid: 'from-1', toUid: 'to-1', amountMinor: 5000, currency: 'TWD' },
    }), ['to-1'])

    const [, doc] = firestoreMock.txCreate.mock.calls[0]!
    expect(doc.body).toContain('TWD 5,000')
  })

  test('stamps expiresAt exactly NOTIFICATION_RETENTION_MS out from now', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    try {
      await writeNotificationDocs(baseEvent(), ['u1'])
      const [, doc] = firestoreMock.txCreate.mock.calls[0]!
      expect((doc.expiresAt as { toMillis(): number }).toMillis()).toBe(1_000_000 + NOTIFICATION_RETENTION_MS)
    } finally {
      nowSpy.mockRestore()
    }
  })
})

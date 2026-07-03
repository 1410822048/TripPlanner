import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Notification } from '@/types/notification'

type QueryConstraint = {
  kind: string
  args: readonly unknown[]
}

const fb = vi.hoisted(() => ({
  db:              {},
  collection:      vi.fn((...path: readonly string[]) => ({ path })),
  where:           vi.fn((...args: readonly unknown[]): QueryConstraint => ({ kind: 'where', args })),
  orderBy:         vi.fn((...args: readonly unknown[]): QueryConstraint => ({ kind: 'orderBy', args })),
  limit:           vi.fn((...args: readonly unknown[]): QueryConstraint => ({ kind: 'limit', args })),
  query:           vi.fn((collection: unknown, ...constraints: readonly QueryConstraint[]) => ({
    collection,
    constraints,
  })),
  getDocs:         vi.fn(),
  onSnapshot:      vi.fn(),
  doc:             vi.fn((...path: readonly unknown[]) => ({ path })),
  updateDoc:       vi.fn(async () => {}),
  serverTimestamp: vi.fn(() => 'SERVER_TS'),
}))

vi.mock('@/services/firebase', () => ({
  getFirebase: vi.fn(async () => fb),
}))

import {
  dismissNotification,
  getNotifications,
  notificationTripIdsFromKey,
  notificationTripIdsKey,
  subscribeToNotifications,
} from './notificationService'

function timestamp(ms: number): Notification['createdAt'] {
  return {
    toDate:   () => new Date(ms),
    toMillis: () => ms,
  } as Notification['createdAt']
}

function notificationDoc(
  id: string,
  tripId: string,
  createdAtMs: number,
  scope: Notification['scope'] = 'trip',
): { id: string; data: () => Omit<Notification, 'id'> } {
  const createdAt = timestamp(createdAtMs)
  return {
    id,
    data: () => ({
      recipientUid: 'user-1',
      tripId,
      tripTitle:    'Tokyo',
      scope,
      entityType:   'expense',
      entityId:     `entity-${id}`,
      action:       'created',
      actorUid:     'actor-1',
      actorName:    'Sato',
      title:        'Expense added',
      body:         'Sato added an expense',
      route:        '/expense',
      createdAt,
      readAt:       null,
      dismissedAt:  null,
      expiresAt:    timestamp(createdAtMs + 1000),
    }),
  }
}

function snapshot(docs: readonly ReturnType<typeof notificationDoc>[]) {
  return { docs, size: docs.length }
}

beforeEach(() => {
  fb.collection.mockClear()
  fb.where.mockClear()
  fb.orderBy.mockClear()
  fb.limit.mockClear()
  fb.query.mockClear()
  fb.getDocs.mockReset()
  fb.onSnapshot.mockReset()
  fb.doc.mockClear()
  fb.updateDoc.mockClear()
  fb.serverTimestamp.mockClear()
})

describe('notification trip id key', () => {
  test('dedupes and sorts accessible trip ids', () => {
    const key = notificationTripIdsKey(['trip-b', 'trip-a', 'trip-b'])

    expect(key).toBe('trip-a,trip-b')
    expect(notificationTripIdsFromKey(key)).toEqual(['trip-a', 'trip-b'])
  })
})

describe('getNotifications', () => {
  test('runs account query + accessible trip chunks, then merges newest rows', async () => {
    const tripIds = Array.from({ length: 31 }, (_, i) => `trip-${String(i).padStart(2, '0')}`)
    // Query order is account (index 0), then chunk-0, chunk-1.
    const pages = [
      snapshot([
        notificationDoc('removed', 'trip-gone', 3500, 'account'),
      ]),
      snapshot([
        notificationDoc('older', 'trip-00', 1000),
        notificationDoc('middle', 'trip-29', 3000),
      ]),
      snapshot([
        notificationDoc('newest', 'trip-30', 4000),
      ]),
    ]
    let pageIndex = 0
    fb.getDocs.mockImplementation(async () => pages[pageIndex++] ?? snapshot([]))

    const rows = await getNotifications('user-1', tripIds)

    expect(rows.map(n => n.id)).toEqual(['newest', 'removed', 'middle', 'older'])
    // 1 account query + 2 trip chunks.
    expect(fb.query).toHaveBeenCalledTimes(3)
    // Account query: dismissedAt==null + scope==account, no tripId filter.
    expect(fb.where).toHaveBeenNthCalledWith(1, 'dismissedAt', '==', null)
    expect(fb.where).toHaveBeenNthCalledWith(2, 'scope', '==', 'account')
    // Each trip chunk: dismissedAt==null + scope==trip + tripId in chunk.
    expect(fb.where).toHaveBeenNthCalledWith(3, 'dismissedAt', '==', null)
    expect(fb.where).toHaveBeenNthCalledWith(4, 'scope', '==', 'trip')
    expect(fb.where).toHaveBeenNthCalledWith(5, 'tripId', 'in', tripIds.slice(0, 30))
    expect(fb.where).toHaveBeenNthCalledWith(6, 'dismissedAt', '==', null)
    expect(fb.where).toHaveBeenNthCalledWith(7, 'scope', '==', 'trip')
    expect(fb.where).toHaveBeenNthCalledWith(8, 'tripId', 'in', tripIds.slice(30))
    expect(fb.orderBy).toHaveBeenCalledWith('createdAt', 'desc')
    expect(fb.limit).toHaveBeenCalledWith(50)
  })

  test('still runs the account query when there are no accessible trips', async () => {
    // A removed member has zero accessible trips but must still see the
    // account-scoped "you were removed" row.
    fb.getDocs.mockResolvedValue(snapshot([
      notificationDoc('removed', 'trip-gone', 2000, 'account'),
    ]))

    const rows = await getNotifications('user-1', [])

    expect(rows.map(n => n.id)).toEqual(['removed'])
    expect(fb.query).toHaveBeenCalledTimes(1)
    expect(fb.getDocs).toHaveBeenCalledTimes(1)
    expect(fb.where).toHaveBeenNthCalledWith(1, 'dismissedAt', '==', null)
    expect(fb.where).toHaveBeenNthCalledWith(2, 'scope', '==', 'account')
    // No trip-scoped filter when there are no accessible trips.
    expect(fb.where).not.toHaveBeenCalledWith('tripId', 'in', expect.anything())
  })
})

describe('dismissNotification', () => {
  test('unread row marks read + dismissed in one write', async () => {
    const unread = { id: 'n1', readAt: null } as Notification

    await dismissNotification('user-1', unread)

    expect(fb.doc).toHaveBeenCalledWith(fb.db, 'users', 'user-1', 'notifications', 'n1')
    expect(fb.updateDoc).toHaveBeenCalledWith(expect.anything(), {
      readAt:      'SERVER_TS',
      dismissedAt: 'SERVER_TS',
    })
  })

  test('already-read row only sets dismissedAt', async () => {
    const read = { id: 'n2', readAt: timestamp(1000) } as Notification

    await dismissNotification('user-1', read)

    expect(fb.updateDoc).toHaveBeenCalledWith(expect.anything(), {
      dismissedAt: 'SERVER_TS',
    })
  })
})

describe('subscribeToNotifications', () => {
  test('waits for account query + every chunk before publishing realtime rows', async () => {
    type Snapshot = ReturnType<typeof snapshot>
    const tripIds = Array.from({ length: 31 }, (_, i) => `trip-${String(i).padStart(2, '0')}`)
    const nexts: Array<(snap: Snapshot) => void> = []
    const unsubs = [vi.fn(), vi.fn(), vi.fn()]
    fb.onSnapshot.mockImplementation((_query: unknown, onNext: (snap: Snapshot) => void) => {
      nexts.push(onNext)
      return unsubs[nexts.length - 1] ?? vi.fn()
    })
    const onData = vi.fn()
    const onError = vi.fn()

    const unsubscribe = await subscribeToNotifications('user-1', tripIds, onData, onError)

    // account (index 0) + 2 trip chunks.
    expect(fb.onSnapshot).toHaveBeenCalledTimes(3)
    nexts[0]?.(snapshot([notificationDoc('removed', 'trip-gone', 3500, 'account')]))
    expect(onData).not.toHaveBeenCalled()

    nexts[1]?.(snapshot([notificationDoc('older', 'trip-00', 1000)]))
    expect(onData).not.toHaveBeenCalled()

    nexts[2]?.(snapshot([notificationDoc('newer', 'trip-30', 3000)]))
    expect(onData).toHaveBeenCalledTimes(1)
    expect(onData.mock.calls[0]?.[0].map((n: Notification) => n.id)).toEqual(['removed', 'newer', 'older'])

    nexts[1]?.(snapshot([notificationDoc('latest', 'trip-29', 5000)]))
    expect(onData).toHaveBeenCalledTimes(2)
    expect(onData.mock.calls[1]?.[0].map((n: Notification) => n.id)).toEqual(['latest', 'removed', 'newer'])

    unsubscribe()
    expect(unsubs[0]).toHaveBeenCalledOnce()
    expect(unsubs[1]).toHaveBeenCalledOnce()
    expect(unsubs[2]).toHaveBeenCalledOnce()
  })
})

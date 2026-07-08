import { beforeEach, describe, expect, test, vi } from 'vitest'

const firestoreMock = vi.hoisted(() => {
  const query = {
    where:   vi.fn(),
    orderBy: vi.fn(),
    limit:   vi.fn(),
    get:     vi.fn(),
  }
  const db = {
    collection: vi.fn(() => query),
  }
  return {
    db,
    query,
    getFirestore: vi.fn(() => db),
  }
})

vi.mock('firebase-admin/firestore', () => ({
  getFirestore: firestoreMock.getFirestore,
  FieldValue: {
    delete:          vi.fn(() => 'field-delete'),
    serverTimestamp: vi.fn(() => 'server-timestamp'),
  },
  Timestamp: {
    fromMillis: vi.fn((ms: number) => ({ toMillis: () => ms })),
  },
}))

import {
  loadEnabledTokens,
  MAX_DISPATCH_ATTEMPTS,
  MAX_TOKENS_PER_USER,
  reservationDecision,
  resolveRecipients,
  selectPushRecipients,
  selectRecipients,
  shouldRetrySendResult,
} from '../dispatch.js'

beforeEach(() => {
  firestoreMock.db.collection.mockClear()
  firestoreMock.query.where.mockReset().mockReturnValue(firestoreMock.query)
  firestoreMock.query.orderBy.mockReset().mockReturnValue(firestoreMock.query)
  firestoreMock.query.limit.mockReset().mockReturnValue(firestoreMock.query)
  firestoreMock.query.get.mockReset().mockResolvedValue({ docs: [] })
})

function timestamp(ms: number) {
  return { toMillis: () => ms }
}

describe('push event reservation', () => {
  test('treats terminal sent/partial events as done (no duplicate notifications)', () => {
    expect(reservationDecision({ status: 'sent', attempt: 1 }, 1000)).toBe('done')
    expect(reservationDecision({ status: 'partial', attempt: 1 }, 1000)).toBe('done')
  })

  test('reports a live-lease pending event as held — caller must defer, not swallow', () => {
    // The regression guard: a valid lease means another invocation is still
    // working it. Returning 'done' here would let dispatchPushEvent report
    // success and kill the retry chain; if that holder was killed mid-send
    // the notification is lost forever. 'held' forces a backoff retry.
    expect(reservationDecision({
      status: 'pending',
      attempt: 1,
      leaseExpiresAt: timestamp(2000),
    }, 1000)).toBe('held')
  })

  test('reserves failed and stale-lease pending events until the attempt cap', () => {
    expect(reservationDecision({ status: 'failed', attempt: 1 }, 1000)).toBe('reserve')
    expect(reservationDecision({
      status: 'pending',
      attempt: 1,
      leaseExpiresAt: timestamp(999),
    }, 1000)).toBe('reserve')
    expect(reservationDecision({ status: 'failed', attempt: MAX_DISPATCH_ATTEMPTS }, 1000)).toBe('done')
  })
})

describe('recipient selection', () => {
  test('excludes the actor (deduped) when the actor is known', () => {
    expect(selectRecipients(['u1', 'u2', 'u1'], 'u1', false)).toEqual(['u2'])
  })

  test('can include the actor for inbox audit rows', () => {
    expect(selectRecipients(['u1', 'u2', 'u1'], 'u1', false, true)).toEqual(['u1', 'u2'])
  })

  test('notifies all parties when the actor is unknown (settlement hard-delete)', () => {
    // settledBy is a best-guess deleter; excluding it would silence the
    // recorder and could push the real (owner) deleter. Notify both.
    expect(selectRecipients(['u1', 'u2'], 'u1', true)).toEqual(['u1', 'u2'])
  })

  test('treats a null actor like an unknown actor — excludes nobody (member role/remove)', () => {
    // member role_changed / removed are admin/Worker writes with no resolvable
    // author. A null actor must never exclude a recipient.
    expect(selectRecipients(['u1', 'u2'], null, false)).toEqual(['u1', 'u2'])
  })
})

describe('resolveRecipients', () => {
  const alive = { deleting: false, memberIds: ['u1', 'u2', 'u3'], title: 'Tokyo' }
  const deleting = { deleting: true, memberIds: [], title: '' }

  test('suppresses ALL notifications while the trip is tearing down', () => {
    // The cascade-delete spam guard: every subcollection/member delete during a
    // trip deletion fires a trigger; a deleting trip must notify nobody, even
    // account-scoped events with explicit partyUids.
    expect(resolveRecipients(deleting, { actorUid: 'u1' })).toEqual([])
    // Even an account-scoped event with explicit partyUids is suppressed.
    expect(resolveRecipients(deleting, { partyUids: ['u2'], actorUid: null })).toEqual([])
  })

  test('trip-scoped events go to members minus the actor', () => {
    expect(resolveRecipients(alive, { actorUid: 'u1' })).toEqual(['u2', 'u3'])
  })

  test('explicit partyUids are used as-is (settlement / account target)', () => {
    expect(resolveRecipients(alive, { partyUids: ['u2'], actorUid: null })).toEqual(['u2'])
  })

  test('trip-scoped member removal drops the removed subject (they get the account copy)', () => {
    expect(resolveRecipients(alive, { actorUid: null, actorUnknown: true, subjectUid: 'u2' })).toEqual(['u1', 'u3'])
  })

  test('member kick keeps the actor in the inbox fan-out and still drops the removed subject', () => {
    expect(resolveRecipients(alive, {
      actorUid: 'u1',
      actorUnknown: false,
      includeActor: true,
      subjectUid: 'u2',
    })).toEqual(['u1', 'u3'])
  })
})

describe('push recipient selection', () => {
  test('can suppress actor self-push while preserving their inbox row', () => {
    expect(selectPushRecipients({ actorUid: 'u1', pushActor: false }, ['u1', 'u3'])).toEqual(['u3'])
  })

  test('pushes every inbox recipient by default', () => {
    expect(selectPushRecipients({ actorUid: 'u1' }, ['u1', 'u3'])).toEqual(['u1', 'u3'])
  })
})

describe('push send retry classification', () => {
  test('retries only all-failed retryable FCM results', () => {
    expect(shouldRetrySendResult({
      sentCount: 0,
      failedCount: 2,
      errorCodes: { 'messaging/unavailable': 2 },
    })).toBe(true)

    expect(shouldRetrySendResult({
      sentCount: 1,
      failedCount: 1,
      errorCodes: { 'messaging/unavailable': 1 },
    })).toBe(false)

    expect(shouldRetrySendResult({
      sentCount: 0,
      failedCount: 2,
      errorCodes: { 'messaging/registration-token-not-registered': 2 },
    })).toBe(false)
  })
})

describe('push token fan-out', () => {
  test('queries the newest bounded enabled token set for a recipient', async () => {
    const docs = Array.from({ length: MAX_TOKENS_PER_USER }, (_, index) => ({
      id:  `hash-${index}`,
      get: vi.fn((field: string) => field === 'token' ? `fcm-token-${'x'.repeat(30)}-${index}` : undefined),
    }))
    firestoreMock.query.get.mockResolvedValueOnce({ docs })

    const tokens = await loadEnabledTokens('user-1')

    expect(firestoreMock.db.collection).toHaveBeenCalledWith('users/user-1/pushTokens')
    expect(firestoreMock.query.where).toHaveBeenCalledWith('disabledAt', '==', null)
    expect(firestoreMock.query.orderBy).toHaveBeenCalledWith('lastSeenAt', 'desc')
    expect(firestoreMock.query.limit).toHaveBeenCalledWith(MAX_TOKENS_PER_USER)
    expect(tokens).toHaveLength(MAX_TOKENS_PER_USER)
  })
})

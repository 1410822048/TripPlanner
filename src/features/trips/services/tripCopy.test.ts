// copyTrip's phase-1 batch is ATOMIC: trip doc + owner member doc commit
// together or not at all. The member-create rule caps displayName at 1..100
// units, so an unnormalized Firebase Auth name fails the whole batch and the
// user sees an opaque 403 on "copy trip" — with no trip created. This file
// pins the payload that batch actually writes.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { User } from 'firebase/auth'
import type { Trip } from '@/types'
import { MOCK_TIMESTAMP as TS } from '@/mocks/utils'

const mocks = vi.hoisted(() => ({
  batchSet:    vi.fn(),
  batchCommit: vi.fn(async () => {}),
  getDocs:     vi.fn(async () => ({ docs: [] })),
}))

vi.mock('@/services/firebase', () => ({
  getFirebase: vi.fn(async () => ({
    db:         {},
    doc:        vi.fn((_db: unknown, ...path: string[]) => ({ id: 'new-trip', path })),
    collection: vi.fn((_db: unknown, ...path: string[]) => ({ path })),
    getDocs:    mocks.getDocs,
    writeBatch: vi.fn(() => ({ set: mocks.batchSet, commit: mocks.batchCommit })),
    query:      vi.fn((...args: unknown[]) => args),
    where:      vi.fn((...args: unknown[]) => args),
    Timestamp:  {
      fromDate: (d: Date) => ({ toDate: () => d, toMillis: () => d.getTime() }),
      now:      () => TS,
    },
    serverTimestamp: vi.fn(() => 'SERVER_TS'),
  })),
}))

import { copyTrip } from './tripCopy'

const source: Trip = {
  id: 'src', title: 'Old', destination: 'Tokyo', icon: '✈️',
  startDate: TS, endDate: TS, currency: 'JPY', defaultCountryCode: 'JP',
  ownerId: 'u1', memberIds: ['u1'], formerMemberNames: {},
  wishVotingDeadlineAt: null, wishVotingDeadlineNotifiedAt: null,
  createdAt: TS, updatedAt: TS,
}

const input = {
  title: 'New', newStartDate: '2026-06-01',
  copySchedules: false, copyPlanning: false,
}

function mkUser(displayName: string | null): User {
  return { uid: 'u1', displayName, photoURL: null } as User
}

/** The member doc payload from phase 1 — the one the rules gate. */
function memberPayload(): Record<string, unknown> {
  const call = mocks.batchSet.mock.calls.find(
    ([, payload]) => (payload as Record<string, unknown>).role === 'owner',
  )
  return call![1] as Record<string, unknown>
}

describe('copyTrip owner member payload', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('normalizes an empty displayName instead of writing one the rules reject', async () => {
    await copyTrip(source, input, mkUser(''))
    expect(memberPayload().displayName).toBe('Me')
  })

  it('caps a long displayName without splitting an emoji', async () => {
    await copyTrip(source, input, mkUser('あ'.repeat(99) + '👍'))
    const name = memberPayload().displayName as string
    expect(name.length).toBeLessThanOrEqual(100)
    expect(/[\uD800-\uDFFF]/.test(name)).toBe(false)
  })

  it('seeds formerMemberNames empty so a copy never inherits departures', async () => {
    await copyTrip(source, input, mkUser('田中'))
    const tripCall = mocks.batchSet.mock.calls.find(
      ([, payload]) => (payload as Record<string, unknown>).ownerId !== undefined,
    )
    expect((tripCall![1] as Record<string, unknown>).formerMemberNames).toEqual({})
  })
})

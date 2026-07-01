import { describe, expect, test } from 'vitest'
import {
  normalizeBookingWrite,
  normalizeExpenseWrite,
  normalizeMemberCreated,
  normalizeSettlementWrite,
  resolveActorUid,
} from '../normalize.js'

describe('resolveActorUid', () => {
  test('trusts auth context only when it matches a rules-pinned actor field', () => {
    expect(resolveActorUid({ authId: 'u1', authType: 'api_key' }, [{ updatedBy: 'u1' }], ['updatedBy'])).toBe('u1')
    expect(resolveActorUid({ authId: 'owner', authType: 'api_key' }, [{ settledBy: 'u1' }], ['settledBy'])).toBe('owner')
    expect(resolveActorUid({ authId: 'service-account@example.com', authType: 'unknown' }, [{ updatedBy: 'u1' }], ['updatedBy'])).toBe('u1')
  })
})

describe('normalizeExpenseWrite', () => {
  const base = {
    tripId: 'trip-1',
    title: 'Lunch',
    amountMinor: 1000,
    updatedBy: 'u1',
    createdBy: 'u1',
    deletedAt: null,
  }

  test('emits create/update/soft-delete and skips infra-only updates', () => {
    expect(normalizeExpenseWrite({
      eventId: 'e1',
      tripId: 'trip-1',
      expenseId: 'expense-1',
      before: null,
      after: base,
    })?.templateKey).toBe('expense.created')

    expect(normalizeExpenseWrite({
      eventId: 'e2',
      tripId: 'trip-1',
      expenseId: 'expense-1',
      before: base,
      after: { ...base, title: 'Dinner', updatedBy: 'u2' },
    })?.templateKey).toBe('expense.updated')

    expect(normalizeExpenseWrite({
      eventId: 'e3',
      tripId: 'trip-1',
      expenseId: 'expense-1',
      before: base,
      after: { ...base, receiptPurgedAt: { toMillis: () => 1 } },
    })).toBeNull()

    expect(normalizeExpenseWrite({
      eventId: 'e4',
      tripId: 'trip-1',
      expenseId: 'expense-1',
      before: base,
      after: { ...base, deletedAt: { toMillis: () => 2 } },
    })?.templateKey).toBe('expense.deleted')
  })
})

describe('normalizeSettlementWrite', () => {
  test('settlement recipients are the two parties, not whole-trip members', () => {
    const event = normalizeSettlementWrite({
      eventId: 's1',
      tripId: 'trip-1',
      settlementId: 'settlement-1',
      before: null,
      after: { fromUid: 'u1', toUid: 'u2', settledBy: 'u1' },
    })
    expect(event?.templateKey).toBe('settlement.created')
    expect(event?.partyUids).toEqual(['u1', 'u2'])
    // create: settledBy IS the actor (only the receiver can record), so it is
    // a trusted actor and stays excludable.
    expect(event?.actorUnknown).toBeUndefined()
  })

  test('settlement hard-delete marks the actor unknown and notifies both parties (defensive fallback)', () => {
    // before.settledBy = the recorder (u2), but the deleter may be the trip
    // owner removing u2's settlement. The deleter's uid never reaches this
    // trigger, so actorUnknown=true keeps BOTH parties as recipients instead
    // of wrongly excluding the recorder. Settlement cancel is soft-delete
    // now (see the test below) -- this branch should no longer fire in
    // normal operation, kept only in case of a future hard-delete write.
    const event = normalizeSettlementWrite({
      eventId: 's2',
      tripId: 'trip-1',
      settlementId: 'settlement-1',
      before: { fromUid: 'u1', toUid: 'u2', settledBy: 'u2' },
      after: null,
    })
    expect(event?.templateKey).toBe('settlement.deleted')
    expect(event?.partyUids).toEqual(['u1', 'u2'])
    expect(event?.actorUnknown).toBe(true)
  })

  test('settlement soft-delete (cancel) resolves the actual canceller via deletedBy, no actorUnknown', () => {
    // Cancel is now an update (deletedBy + deletedAt stamped, doc stays),
    // so the canceller's uid IS available -- unlike hard-delete, no guess
    // is needed and only the canceller is excluded from the notification.
    const event = normalizeSettlementWrite({
      eventId: 's3',
      tripId: 'trip-1',
      settlementId: 'settlement-1',
      before: { fromUid: 'u1', toUid: 'u2', settledBy: 'u2', deletedAt: null },
      after:  { fromUid: 'u1', toUid: 'u2', settledBy: 'u2', deletedAt: '2026-07-01T00:00:00Z', deletedBy: 'u1' },
    })
    expect(event?.templateKey).toBe('settlement.deleted')
    expect(event?.partyUids).toEqual(['u1', 'u2'])
    expect(event?.actorUid).toBe('u1')
    expect(event?.actorUnknown).toBeUndefined()
  })

  test('settlement soft-delete by the recorder themselves excludes them, not the other party', () => {
    const event = normalizeSettlementWrite({
      eventId: 's4',
      tripId: 'trip-1',
      settlementId: 'settlement-1',
      before: { fromUid: 'u1', toUid: 'u2', settledBy: 'u2', deletedAt: null },
      after:  { fromUid: 'u1', toUid: 'u2', settledBy: 'u2', deletedAt: '2026-07-01T00:00:00Z', deletedBy: 'u2' },
    })
    expect(event?.actorUid).toBe('u2')
    expect(event?.actorUnknown).toBeUndefined()
  })
})

describe('normalizeBookingWrite', () => {
  test('skips memberIds-only booking cascade updates', () => {
    expect(normalizeBookingWrite({
      eventId: 'b1',
      tripId: 'trip-1',
      bookingId: 'booking-1',
      before: { type: 'hotel', title: 'Hotel', memberIds: ['u1'], updatedBy: 'u1' },
      after: { type: 'hotel', title: 'Hotel', memberIds: ['u1', 'u2'], updatedBy: 'u1' },
    })).toBeNull()
  })
})

describe('normalizeMemberCreated', () => {
  test('skips owner bootstrap and emits non-owner join', () => {
    expect(normalizeMemberCreated({
      eventId: 'm0',
      tripId: 'trip-1',
      memberId: 'owner',
      after: { userId: 'owner', role: 'owner' },
    })).toBeNull()

    expect(normalizeMemberCreated({
      eventId: 'm1',
      tripId: 'trip-1',
      memberId: 'u2',
      after: { userId: 'u2', role: 'editor' },
    })?.templateKey).toBe('member.joined')
  })
})

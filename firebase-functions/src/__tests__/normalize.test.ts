import { describe, expect, test } from 'vitest'
import {
  normalizeBookingWrite,
  normalizeExpenseWrite,
  normalizeMemberWrite,
  normalizePlanningWrite,
  normalizeScheduleWrite,
  normalizeSettlementWrite,
  normalizeTripRootWrite,
  normalizeWishWrite,
  resolveActorUid,
} from '../normalize.js'
import type { NormalizedPushEvent } from '../model.js'

// Every normalizer now returns NormalizedPushEvent[] (0 = skip, 2 = fan-out).
// `single` asserts exactly one event and hands it back for field assertions.
function single(events: NormalizedPushEvent[]): NormalizedPushEvent {
  expect(events).toHaveLength(1)
  return events[0]!
}

// Web SDK writes surface as api_key; used where actor resolution needs auth
// context rather than a document field (trip-root edits).
const webAuth = { authId: 'u1', authType: 'api_key' }

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
    expect(single(normalizeExpenseWrite({
      eventId: 'e1', tripId: 'trip-1', expenseId: 'expense-1', before: null, after: base,
    })).templateKey).toBe('expense.created')

    expect(single(normalizeExpenseWrite({
      eventId: 'e2', tripId: 'trip-1', expenseId: 'expense-1',
      before: base, after: { ...base, title: 'Dinner', updatedBy: 'u2' },
    })).templateKey).toBe('expense.updated')

    expect(normalizeExpenseWrite({
      eventId: 'e3', tripId: 'trip-1', expenseId: 'expense-1',
      before: base, after: { ...base, receiptPurgedAt: { toMillis: () => 1 } },
    })).toEqual([])

    expect(single(normalizeExpenseWrite({
      eventId: 'e4', tripId: 'trip-1', expenseId: 'expense-1',
      before: base, after: { ...base, deletedAt: { toMillis: () => 2 } },
    })).templateKey).toBe('expense.deleted')
  })
})

describe('normalizeSettlementWrite', () => {
  test('settlement recipients are the two parties, not whole-trip members', () => {
    const event = single(normalizeSettlementWrite({
      eventId: 's1', tripId: 'trip-1', settlementId: 'settlement-1',
      before: null, after: { fromUid: 'u1', toUid: 'u2', settledBy: 'u1' },
    }))
    expect(event.templateKey).toBe('settlement.created')
    expect(event.partyUids).toEqual(['u1', 'u2'])
    expect(event.actorUnknown).toBeUndefined()
  })

  test('settlement hard-delete marks the actor unknown and notifies both parties (defensive fallback)', () => {
    const event = single(normalizeSettlementWrite({
      eventId: 's2', tripId: 'trip-1', settlementId: 'settlement-1',
      before: { fromUid: 'u1', toUid: 'u2', settledBy: 'u2' }, after: null,
    }))
    expect(event.templateKey).toBe('settlement.deleted')
    expect(event.partyUids).toEqual(['u1', 'u2'])
    expect(event.actorUnknown).toBe(true)
  })

  test('settlement soft-delete (cancel) resolves the actual canceller via deletedBy, no actorUnknown', () => {
    const event = single(normalizeSettlementWrite({
      eventId: 's3', tripId: 'trip-1', settlementId: 'settlement-1',
      before: { fromUid: 'u1', toUid: 'u2', settledBy: 'u2', deletedAt: null },
      after:  { fromUid: 'u1', toUid: 'u2', settledBy: 'u2', deletedAt: '2026-07-01T00:00:00Z', deletedBy: 'u1' },
    }))
    expect(event.templateKey).toBe('settlement.deleted')
    expect(event.partyUids).toEqual(['u1', 'u2'])
    expect(event.actorUid).toBe('u1')
    expect(event.actorUnknown).toBeUndefined()
  })

  test('settlement info requires a non-negative integer amountMinor', () => {
    const decimal = single(normalizeSettlementWrite({
      eventId: 's5', tripId: 'trip-1', settlementId: 'settlement-1',
      before: null, after: { fromUid: 'u1', toUid: 'u2', settledBy: 'u2', amountMinor: 10.5, currency: 'JPY' },
    }))
    const negative = single(normalizeSettlementWrite({
      eventId: 's6', tripId: 'trip-1', settlementId: 'settlement-1',
      before: null, after: { fromUid: 'u1', toUid: 'u2', settledBy: 'u2', amountMinor: -1, currency: 'JPY' },
    }))
    expect(decimal.settlement).toBeUndefined()
    expect(negative.settlement).toBeUndefined()
  })
})

describe('normalizeBookingWrite', () => {
  const base = { type: 'hotel', title: 'Hotel', updatedBy: 'u1', createdBy: 'u1' }

  test('skips memberIds-only booking cascade updates', () => {
    expect(normalizeBookingWrite({
      eventId: 'b1', tripId: 'trip-1', bookingId: 'booking-1',
      before: { ...base, memberIds: ['u1'] }, after: { ...base, memberIds: ['u1', 'u2'] },
    })).toEqual([])
  })

  test('emits create / meaningful-update / delete', () => {
    expect(single(normalizeBookingWrite({
      eventId: 'b2', tripId: 'trip-1', bookingId: 'booking-1', before: null, after: base,
    })).templateKey).toBe('booking.created')

    expect(single(normalizeBookingWrite({
      eventId: 'b3', tripId: 'trip-1', bookingId: 'booking-1',
      before: base, after: { ...base, title: 'New Hotel', updatedBy: 'u2' },
    })).templateKey).toBe('booking.updated')

    const del = single(normalizeBookingWrite({
      eventId: 'b4', tripId: 'trip-1', bookingId: 'booking-1', before: base, after: null,
    }))
    expect(del.templateKey).toBe('booking.deleted')
    expect(del.actorUid).toBe('u1')
  })
})

describe('normalizeScheduleWrite', () => {
  const base = { title: 'Museum', date: '2026-07-01', order: 1, createdBy: 'u1', updatedBy: 'u1' }

  test('emits create / delete / meaningful-update but not reorder', () => {
    expect(single(normalizeScheduleWrite({
      eventId: 'sc1', tripId: 'trip-1', scheduleId: 's-1', before: null, after: base,
    })).templateKey).toBe('schedule.created')

    // order-only change (drag reorder) is silent.
    expect(normalizeScheduleWrite({
      eventId: 'sc2', tripId: 'trip-1', scheduleId: 's-1',
      before: base, after: { ...base, order: 5, updatedBy: 'u2' },
    })).toEqual([])

    expect(single(normalizeScheduleWrite({
      eventId: 'sc3', tripId: 'trip-1', scheduleId: 's-1',
      before: base, after: { ...base, title: 'Aquarium', updatedBy: 'u2' },
    })).templateKey).toBe('schedule.updated')

    expect(single(normalizeScheduleWrite({
      eventId: 'sc4', tripId: 'trip-1', scheduleId: 's-1', before: base, after: null,
    })).templateKey).toBe('schedule.deleted')
  })
})

describe('normalizeWishWrite', () => {
  const base = { title: 'Ramen', category: 'food', description: 'old', link: 'https://old.example', address: 'Tokyo', proposedBy: 'u1', updatedBy: 'u1', votes: [] }

  test('emits create / content-update / delete; vote toggle is silent', () => {
    expect(single(normalizeWishWrite({
      eventId: 'w1', tripId: 'trip-1', wishId: 'wish-1', before: null, after: base,
    })).templateKey).toBe('wish.created')

    // Vote toggle is an update → silent.
    expect(normalizeWishWrite({
      eventId: 'w2', tripId: 'trip-1', wishId: 'wish-1',
      before: base, after: { ...base, votes: ['u2'], updatedBy: 'u2' },
    })).toEqual([])

    const edit = single(normalizeWishWrite({
      eventId: 'w2b', tripId: 'trip-1', wishId: 'wish-1',
      before: base, after: { ...base, title: 'Tsukemen', updatedBy: 'u2' },
    }))
    expect(edit.templateKey).toBe('wish.updated')
    expect(edit.push).toBeUndefined()

    expect(single(normalizeWishWrite({
      eventId: 'w3', tripId: 'trip-1', wishId: 'wish-1', before: base, after: null,
    })).templateKey).toBe('wish.deleted')
  })
})

describe('normalizePlanningWrite', () => {
  const base = { title: 'Passport', category: 'documents', completedBy: {}, createdBy: 'u1', updatedBy: 'u1' }

  test('create/delete/content edit push; completion toggle is silent', () => {
    expect(single(normalizePlanningWrite({
      eventId: 'p1', tripId: 'trip-1', planItemId: 'plan-1', before: null, after: base,
    })).templateKey).toBe('planning.created')

    // Per-member completion toggle only → silent.
    expect(normalizePlanningWrite({
      eventId: 'p2', tripId: 'trip-1', planItemId: 'plan-1',
      before: base, after: { ...base, completedBy: { u2: { toMillis: () => 1 } }, updatedBy: 'u2' },
    })).toEqual([])

    // content edit → push + inbox.
    const edit = single(normalizePlanningWrite({
      eventId: 'p3', tripId: 'trip-1', planItemId: 'plan-1',
      before: base, after: { ...base, note: 'expires 2027', updatedBy: 'u2' },
    }))
    expect(edit.templateKey).toBe('planning.updated')
    expect(edit.push).toBeUndefined()

    expect(single(normalizePlanningWrite({
      eventId: 'p4', tripId: 'trip-1', planItemId: 'plan-1', before: base, after: null,
    })).templateKey).toBe('planning.deleted')
  })
})

describe('normalizeTripRootWrite', () => {
  const base = { title: 'Tokyo', destination: '東京', startDate: { toMillis: () => 1 }, endDate: { toMillis: () => 2 }, icon: '✈️' }

  test('one event per save, priority dates > destination > title/icon', () => {
    // dates + title change together → dates wins, pushes.
    const dates = single(normalizeTripRootWrite({
      eventId: 't1', tripId: 'trip-1', auth: webAuth,
      before: base, after: { ...base, title: 'Osaka', startDate: { toMillis: () => 9 } },
    }))
    expect(dates.templateKey).toBe('trip.dates_updated')
    expect(dates.push).toBeUndefined()

    const dest = single(normalizeTripRootWrite({
      eventId: 't2', tripId: 'trip-1', auth: webAuth,
      before: base, after: { ...base, destination: '大阪' },
    }))
    expect(dest.templateKey).toBe('trip.destination_updated')

    // title only → inbox-only (push:false).
    const title = single(normalizeTripRootWrite({
      eventId: 't3', tripId: 'trip-1', auth: webAuth,
      before: base, after: { ...base, title: 'Renamed' },
    }))
    expect(title.templateKey).toBe('trip.title_updated')
    expect(title.push).toBe(false)

    // icon only → decorative, fully silent.
    expect(normalizeTripRootWrite({
      eventId: 't3b', tripId: 'trip-1', auth: webAuth,
      before: base, after: { ...base, icon: '🗻' },
    })).toEqual([])
  })

  test('skips activity/metadata-only updates and create/delete', () => {
    expect(normalizeTripRootWrite({
      eventId: 't4', tripId: 'trip-1', auth: webAuth,
      before: base, after: { ...base, lastActivityByFeature: { expense: { by: 'u2' } } },
    })).toEqual([])

    expect(normalizeTripRootWrite({
      eventId: 't5', tripId: 'trip-1', auth: webAuth, before: null, after: base,
    })).toEqual([])
  })
})

describe('normalizeMemberWrite', () => {
  test('skips owner bootstrap and emits non-owner join', () => {
    expect(normalizeMemberWrite({
      eventId: 'm0', tripId: 'trip-1', memberId: 'owner', before: null, after: { userId: 'owner', role: 'owner' },
    })).toEqual([])

    expect(single(normalizeMemberWrite({
      eventId: 'm1', tripId: 'trip-1', memberId: 'u2', before: null, after: { userId: 'u2', role: 'editor' },
    })).templateKey).toBe('member.joined')
  })

  test('role change notifies the subject, carries new role, allows a null actor', () => {
    const event = single(normalizeMemberWrite({
      eventId: 'm2', tripId: 'trip-1', memberId: 'u2',
      before: { userId: 'u2', displayName: 'Aki', role: 'viewer' },
      after:  { userId: 'u2', displayName: 'Aki', role: 'editor' },
    }))
    expect(event.templateKey).toBe('member.role_changed')
    expect(event.partyUids).toEqual(['u2'])
    expect(event.subjectUid).toBe('u2')
    expect(event.subjectRole).toBe('editor')
    expect(event.actorUnknown).toBe(true)
    expect(event.actorUid).toBeNull()

    // No role change → silent.
    expect(normalizeMemberWrite({
      eventId: 'm3', tripId: 'trip-1', memberId: 'u2',
      before: { userId: 'u2', role: 'editor', displayName: 'Aki' },
      after:  { userId: 'u2', role: 'editor', displayName: 'Akira' },
    })).toEqual([])
  })

  test('kick (removalKind removed) fans out to a trip-scoped copy + an account-scoped self copy with distinct ids', () => {
    const events = normalizeMemberWrite({
      eventId: 'm4', tripId: 'trip-1', memberId: 'u2',
      before: { userId: 'u2', displayName: 'Aki', role: 'editor', removalKind: 'removed', removedBy: 'owner-1' }, after: null,
    })
    expect(events).toHaveLength(2)

    const [remaining, self] = events
    expect(remaining!.templateKey).toBe('member.removed')
    expect(remaining!.eventId).toBe('m4')
    expect(remaining!.scope).toBeUndefined()
    expect(remaining!.subjectUid).toBe('u2')
    // removedBy is a trusted actor → excluded from the fan-out, so the kicking
    // owner isn't pushed about their own action.
    expect(remaining!.actorUid).toBe('owner-1')
    expect(remaining!.actorUnknown).toBe(false)

    expect(self!.templateKey).toBe('member.removed_self')
    expect(self!.eventId).toBe('m4:self')
    expect(self!.scope).toBe('account')
    expect(self!.partyUids).toEqual(['u2'])
    expect(self!.route).toBe('/account')
  })

  test('self-leave (removalKind left) notifies remaining members only — no "you were removed" self copy', () => {
    const events = normalizeMemberWrite({
      eventId: 'm5', tripId: 'trip-1', memberId: 'u2',
      before: { userId: 'u2', displayName: 'Aki', role: 'editor', removalKind: 'left' }, after: null,
    })
    expect(events).toHaveLength(1)
    expect(events[0]!.templateKey).toBe('member.left')
    expect(events[0]!.scope).toBeUndefined()
    expect(events[0]!.subjectUid).toBe('u2')
  })

  test('missing removalKind/removedBy (legacy / trip-cascade) defaults to the kick fan-out with unknown actor', () => {
    const events = normalizeMemberWrite({
      eventId: 'm6', tripId: 'trip-1', memberId: 'u2',
      before: { userId: 'u2', displayName: 'Aki', role: 'editor' }, after: null,
    })
    expect(events.map(e => e.templateKey)).toEqual(['member.removed', 'member.removed_self'])
    // No removedBy → actor unknown → notify everyone remaining (no exclusion).
    expect(events[0]!.actorUid).toBeNull()
    expect(events[0]!.actorUnknown).toBe(true)
  })
})

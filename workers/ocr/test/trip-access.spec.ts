// The shared trip-access gate (membership-shared.ts): one fixed order for
// every endpoint — 404 → 410 → 403 non-member → 403 removing → 403 wish
// deadline → 403 role.
import { describe, it, expect } from 'vitest'
import { checkTripAccess } from '../src/membership-shared'

const UID = 'caller'
const trip = (extra: Record<string, unknown> = {}) => ({
  ownerId:   { stringValue: 'owner' },
  memberIds: { arrayValue: { values: [{ stringValue: 'owner' }, { stringValue: UID }] } },
  ...extra,
}) as never
const member = (role: string, extra: Record<string, unknown> = {}) => ({ role: { stringValue: role }, ...extra }) as never
const PAST = { timestampValue: '2020-01-01T00:00:00Z' }

describe('checkTripAccess', () => {
  it('returns role, ownership and roster for an allowed caller', () => {
    expect(checkTripAccess(trip(), member('editor'), UID)).toMatchObject({
      role: 'editor', isOwner: false, roster: ['owner', UID],
    })
    expect(checkTripAccess(trip({ ownerId: { stringValue: UID } }), member('owner'), UID).isOwner).toBe(true)
  })

  it('applies the checks in the fixed order', () => {
    const deleting = trip({ deletingAt: PAST, wishVotingDeadlineAt: PAST })
    expect(() => checkTripAccess(null, null, UID)).toThrow(expect.objectContaining({ status: 404 }))
    // Deleting beats everything about the member.
    expect(() => checkTripAccess(deleting, null, UID)).toThrow(expect.objectContaining({ status: 410 }))
    expect(() => checkTripAccess(trip(), null, UID)).toThrow(/not a trip member/)
    // Removing beats the deadline and the role.
    const closed = trip({ wishVotingDeadlineAt: PAST })
    expect(() => checkTripAccess(closed, member('viewer', { removingAt: PAST }), UID, { wishVotingOpen: true, roles: ['owner'] }))
      .toThrow(/being removed/)
    // Deadline beats the role.
    expect(() => checkTripAccess(closed, member('viewer'), UID, { wishVotingOpen: true, roles: ['owner'] }))
      .toThrow(/deadline/)
    expect(() => checkTripAccess(trip(), member('viewer'), UID, { roles: ['owner', 'editor'] }))
      .toThrow(/owner\/editor/)
  })

  it('opt-outs: deleting trips, removing members, skipped role check', () => {
    expect(() => checkTripAccess(trip({ deletingAt: PAST }), member('editor'), UID, { allowDeleting: true })).not.toThrow()
    expect(() => checkTripAccess(trip(), member('editor', { removingAt: PAST }), UID, { allowRemoving: true })).not.toThrow()
    expect(() => checkTripAccess(trip(), member('weird'), UID)).toThrow(/role invalid/)
    expect(() => checkTripAccess(trip(), member('weird'), UID, { roles: null })).not.toThrow()
  })

  it('words an owner-only refusal as such', () => {
    expect(() => checkTripAccess(trip(), member('editor'), UID, { roles: ['owner'] })).toThrow('caller is not the trip owner')
  })
})

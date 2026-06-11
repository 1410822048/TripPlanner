// Wire-body regression for memberService's Worker-authoritative mutations.
// Pins the exact endpoint + payload each one POSTs so a regression that
// drops/renames a field (or hits the wrong route) is caught here, not at the
// Worker boundary in prod. Mirrors the bookingService.test mock style
// (vi.hoisted + mock @/services/workerBase).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireWorkerWriteBaseMock: vi.fn(() => 'https://worker.test'),
  preflightIdTokenMock:       vi.fn(async () => 'tok-test'),
  workerFetchMock:            vi.fn(async () => undefined),
}))

vi.mock('@/services/workerBase', () => ({
  requireWorkerWriteBase: mocks.requireWorkerWriteBaseMock,
  preflightIdToken:       mocks.preflightIdTokenMock,
  workerFetch:            mocks.workerFetchMock,
}))

import { transferOwnership, leaveMember, removeMember, updateMemberRole } from './memberService'

beforeEach(() => {
  mocks.workerFetchMock.mockClear()
  mocks.requireWorkerWriteBaseMock.mockClear()
  mocks.preflightIdTokenMock.mockClear()
})

describe('memberService Worker wire bodies', () => {
  it('transferOwnership → POST /owner-transfer { tripId, targetUid }', async () => {
    await transferOwnership('t1', 'u2')
    expect(mocks.workerFetchMock).toHaveBeenCalledWith(
      'https://worker.test', 'tok-test', '/owner-transfer',
      { tripId: 't1', targetUid: 'u2' },
    )
  })

  it('leaveMember → POST /member-leave { tripId } (no memberUid; caller is the target)', async () => {
    await leaveMember('t1')
    // Exact-object match already pins the absence of memberUid — leave's
    // target is the verified token uid, never a client-supplied field.
    expect(mocks.workerFetchMock).toHaveBeenCalledWith(
      'https://worker.test', 'tok-test', '/member-leave', { tripId: 't1' },
    )
  })

  it('removeMember → POST /member-remove { tripId, memberUid }', async () => {
    await removeMember('t1', 'u2')
    expect(mocks.workerFetchMock).toHaveBeenCalledWith(
      'https://worker.test', 'tok-test', '/member-remove', { tripId: 't1', memberUid: 'u2' },
    )
  })

  it('updateMemberRole → POST /member-role-update { tripId, memberUid, role }', async () => {
    await updateMemberRole('t1', 'u2', 'viewer')
    expect(mocks.workerFetchMock).toHaveBeenCalledWith(
      'https://worker.test', 'tok-test', '/member-role-update',
      { tripId: 't1', memberUid: 'u2', role: 'viewer' },
    )
  })
})

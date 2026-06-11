// Service-layer regression tests for tripService's /members
// collection-group → tripId extraction.
//
// Pin: a member doc carrying `removingAt` (the mid-removal marker the
// Worker stamps BEFORE stripping memberIds + deleting the doc, for both
// /member-remove and /member-leave) must NOT surface its trip id. This CG
// query matches on `userId` — NOT `memberIds` — so without the filter the
// trip lingers in the switcher until the final delete lands, and a failed
// delete would leave a permanent ghost id. Both paths must drop marker-
// present docs: the one-shot getMyTripIds (via memberDocsToTripIds) and
// the realtime subscribeToMyTripIds (via fromDoc + postProcess).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  getDocsMock:               vi.fn(),
  subscribeToCollectionMock: vi.fn(),
  captureErrorMock:          vi.fn(),
}))

vi.mock('@/services/firebase', () => ({
  getFirebase: vi.fn(async () => ({
    db:              {},
    collectionGroup: vi.fn(() => ({ _kind: 'cg' })),
    query:           vi.fn((...args: unknown[]) => ({ _kind: 'query', args })),
    where:           vi.fn((...args: unknown[]) => ({ _kind: 'where', args })),
    limit:           vi.fn((n: number) => ({ _kind: 'limit', n })),
    getDocs:         mocks.getDocsMock,
  })),
}))

vi.mock('@/services/realtimeQuery', () => ({
  subscribeToCollection: mocks.subscribeToCollectionMock,
}))

vi.mock('@/services/sentry', () => ({
  captureError: mocks.captureErrorMock,
}))

import { getMyTripIds, subscribeToMyTripIds } from './tripService'

// Minimal /members collection-group doc shape both paths read: data() for
// the removingAt marker, ref.parent.parent.id for the parent trip id.
interface FakeMemberDoc {
  data: () => Record<string, unknown>
  ref:  { parent: { parent: { id: string } | null } }
}
function memberDoc(tripId: string | null, opts: { removingAt?: boolean } = {}): FakeMemberDoc {
  return {
    data: () => ({ userId: 'u1', ...(opts.removingAt ? { removingAt: { seconds: 1, nanoseconds: 0 } } : {}) }),
    ref:  { parent: { parent: tripId === null ? null : { id: tripId } } },
  }
}

beforeEach(() => {
  mocks.getDocsMock.mockReset()
  mocks.subscribeToCollectionMock.mockReset()
  mocks.captureErrorMock.mockReset()
})

describe('getMyTripIds — removingAt filter', () => {
  it('drops trip ids whose member doc carries removingAt', async () => {
    mocks.getDocsMock.mockResolvedValueOnce({
      size: 3,
      docs: [memberDoc('t1'), memberDoc('t2', { removingAt: true }), memberDoc('t3')],
    })

    expect(await getMyTripIds('u1')).toEqual(['t1', 't3'])
    expect(mocks.captureErrorMock).not.toHaveBeenCalled()  // no truncation
  })

  it('all-clean docs pass through, deduped', async () => {
    mocks.getDocsMock.mockResolvedValueOnce({
      size: 2,
      docs: [memberDoc('t1'), memberDoc('t1')],  // defensive dedup
    })

    expect(await getMyTripIds('u1')).toEqual(['t1'])
  })

  it('a sole removingAt doc yields no ids', async () => {
    mocks.getDocsMock.mockResolvedValueOnce({
      size: 1,
      docs: [memberDoc('t1', { removingAt: true })],
    })

    expect(await getMyTripIds('u1')).toEqual([])
  })
})

describe('subscribeToMyTripIds — removingAt filter', () => {
  it('fromDoc maps clean→id, removingAt→"", orphan→""; postProcess drops blanks + dedups', () => {
    mocks.subscribeToCollectionMock.mockReturnValue(() => {})

    subscribeToMyTripIds('u1', () => {}, () => {})

    expect(mocks.subscribeToCollectionMock).toHaveBeenCalledTimes(1)
    const opts = mocks.subscribeToCollectionMock.mock.calls[0]![0] as {
      fromDoc:     (d: FakeMemberDoc) => string
      postProcess: (ids: string[]) => string[]
    }

    // fromDoc: clean → trip id; removingAt → '' (filtered downstream);
    // orphan (no parent trip) → '' as well.
    expect(opts.fromDoc(memberDoc('t1'))).toBe('t1')
    expect(opts.fromDoc(memberDoc('t2', { removingAt: true }))).toBe('')
    expect(opts.fromDoc(memberDoc(null))).toBe('')

    // postProcess: drop the '' blanks (removingAt + orphans) and dedup.
    expect(opts.postProcess(['t1', '', 't1', 't2', ''])).toEqual(['t1', 't2'])
  })
})

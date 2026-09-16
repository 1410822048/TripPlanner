import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Timestamp } from 'firebase/firestore'

const mocks = vi.hoisted(() => ({
  getDocs: vi.fn(), onSnapshot: vi.fn(), captureError: vi.fn(), markPerf: vi.fn(),
  collection: vi.fn((...args: unknown[]) => ({ collection: args.slice(1) })),
  query: vi.fn((...args: unknown[]) => ({ query: args })),
  where: vi.fn((...args: unknown[]) => ({ where: args })),
  limit: vi.fn((n: number) => ({ limit: n })),
}))
vi.mock('@/services/firebase', () => ({ getFirebase: async () => ({ db: {}, ...mocks }) }))
vi.mock('@/services/sentry', () => ({ captureError: mocks.captureError }))
vi.mock('@/utils/perf', () => ({ markPerf: mocks.markPerf }))
import { getMyTrips, subscribeToMyTrips } from './tripService'

function tripDoc(id: string, millis = 1) {
  const ts = Timestamp.fromMillis(millis)
  return { id, data: vi.fn(() => ({
    title: id, destination: 'Taipei', startDate: ts, endDate: ts,
    currency: 'TWD', defaultCountryCode: 'TW', ownerId: 'u1', memberIds: ['u1'],
    formerMemberNames: {}, wishVotingDeadlineAt: null, wishVotingDeadlineNotifiedAt: null,
    createdAt: ts, updatedAt: ts,
  })) }
}
const snap = (docs: Array<{ id: string; data: () => object }>) => ({ docs, size: docs.length })
beforeEach(() => vi.clearAllMocks())

describe('membership-filtered trips', () => {
  it('fetches directly with the same query used by the single listener', async () => {
    mocks.getDocs.mockResolvedValue(snap([]))
    await getMyTrips('u1')
    const unsub = vi.fn()
    mocks.onSnapshot.mockReturnValue(unsub)
    expect(await subscribeToMyTrips('u1', vi.fn(), vi.fn())).toBe(unsub)
    expect(mocks.getDocs.mock.calls[0]![0]).toEqual(mocks.onSnapshot.mock.calls[0]![0])
    expect(mocks.collection).toHaveBeenCalledWith({}, 'trips')
    expect(mocks.where).toHaveBeenCalledWith('memberIds', 'array-contains', 'u1')
    expect(mocks.limit).toHaveBeenCalledWith(50)
  })

  it('sorts full parsed trips by createdAt and estimates pending timestamps', async () => {
    const a = tripDoc('a', 1), b = tripDoc('b', 2)
    mocks.getDocs.mockResolvedValue(snap([a, b]))
    expect((await getMyTrips('u1')).map(t => t.id)).toEqual(['b', 'a'])
    expect(a.data).toHaveBeenCalledWith({ serverTimestamps: 'estimate' })
  })

  it('skips malformed documents without discarding valid trips', async () => {
    mocks.getDocs.mockResolvedValue(snap([{ id: 'bad', data: () => ({}) }, tripDoc('good')]))
    expect((await getMyTrips('u1')).map(t => t.id)).toEqual(['good'])
    expect(mocks.captureError).toHaveBeenCalledTimes(1)
  })

  it.each([0, 1, 50])('handles %i rows and warns only at the cap', async count => {
    mocks.getDocs.mockResolvedValue(snap(Array.from({ length: count }, (_, i) => tripDoc(String(i)))))
    expect(await getMyTrips('u1')).toHaveLength(count)
    expect(mocks.captureError).toHaveBeenCalledTimes(count === 50 ? 1 : 0)
  })

  it('publishes joins, metadata changes and departures; marks first nonempty push once', async () => {
    const onData = vi.fn(), onError = vi.fn()
    await subscribeToMyTrips('u1', onData, onError)
    const publish = mocks.onSnapshot.mock.calls[0]![1] as (s: ReturnType<typeof snap>) => void
    publish(snap([]))
    expect(mocks.markPerf).not.toHaveBeenCalled()
    publish(snap([tripDoc('a'), tripDoc('b', 2)]))
    expect(onData.mock.lastCall![0].map((t: { id: string }) => t.id)).toEqual(['b', 'a'])
    publish(snap([tripDoc('a', 3)]))
    expect(onData.mock.lastCall![0]).toHaveLength(1)
    publish(snap([]))
    expect(onData.mock.lastCall![0]).toEqual([])
    expect(mocks.markPerf).toHaveBeenCalledExactlyOnceWith('mytrips-first-publish')
    expect(mocks.onSnapshot.mock.calls[0]![2]).toBe(onError)
  })

  it('keeps listener parsing tolerant and reports truncation', async () => {
    const onData = vi.fn()
    await subscribeToMyTrips('u1', onData, vi.fn())
    const publish = mocks.onSnapshot.mock.calls[0]![1] as (s: ReturnType<typeof snap>) => void
    publish(snap([{ id: 'bad', data: () => ({}) }, ...Array.from({ length: 49 }, (_, i) => tripDoc(String(i)))]))
    expect(onData.mock.lastCall![0]).toHaveLength(49)
    expect(mocks.captureError).toHaveBeenCalledTimes(2)
  })
})

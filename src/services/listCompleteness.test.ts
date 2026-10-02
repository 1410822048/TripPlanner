import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueryDocumentSnapshot, QuerySnapshot } from 'firebase/firestore'
import { createTripScopedListServices } from './tripScopedList'
import { subscribeToCollection } from './realtimeQuery'

const fb = vi.hoisted(() => ({
  db: {}, collection: vi.fn(), where: vi.fn(), orderBy: vi.fn(), limit: vi.fn(),
  query: vi.fn(), getDocs: vi.fn(), getDocsFromServer: vi.fn(), onSnapshot: vi.fn(),
}))
vi.mock('./firebase', () => ({ getFirebase: async () => fb }))
vi.mock('./sentry', () => ({ captureError: vi.fn() }))

function snapshot(ids: string[]): QuerySnapshot {
  return { size: ids.length, docs: ids.map(id => ({ id })), metadata: { fromCache: false, hasPendingWrites: false } } as unknown as QuerySnapshot
}
function services(requireComplete: boolean) {
  return createTripScopedListServices({
    path: () => ['trips', 't', 'expenses'], orderBy: [['date', 'desc']],
    source: 'test', limit: 2, requireComplete,
    fromDoc: (doc: QueryDocumentSnapshot) => {
      if (doc.id === 'bad') throw new Error('bad schema')
      return doc.id
    },
  })
}
beforeEach(() => vi.clearAllMocks())

describe('complete financial lists', () => {
  it.each(['fromCache', 'hasPendingWrites'] as const)('refuses an unconfirmed one-shot result: %s', async field => {
    const snap = snapshot(['a'])
    fb.getDocsFromServer.mockResolvedValue({ ...snap, metadata: { fromCache: false, hasPendingWrites: false, [field]: true } })
    await expect(services(true).fetch('t', 'u')).rejects.toThrow('伺服器確認')
    expect(fb.getDocs).not.toHaveBeenCalled()
  })
  it('keeps a malformed cached preview nonterminal until server validation', async () => {
    const onData = vi.fn(), onError = vi.fn()
    await services(true).subscribe('t', 'u', onData, onError)
    expect(fb.onSnapshot.mock.calls[0]![1]).toEqual({ includeMetadataChanges: true })
    const callback = fb.onSnapshot.mock.calls[0]![2] as (snap: QuerySnapshot) => void
    callback({ ...snapshot(['a', 'bad']), metadata: { fromCache: true, hasPendingWrites: false } } as QuerySnapshot)
    expect(onData).toHaveBeenCalledWith(['a'], { fromCache: true, hasPendingWrites: false })
    expect(onError).not.toHaveBeenCalled()
    callback(snapshot(['a', 'bad']))
    expect(onError).toHaveBeenCalledOnce()
  })
  it('still rejects malformed rows when a complete subscriber has no query cap', async () => {
    const onData = vi.fn()
    const onError = vi.fn()
    await subscribeToCollection({ buildQuery: () => fb.query(), source: 'test', requireComplete: true,
      fromDoc: () => { throw new Error('bad schema') } }, onData, onError)
    const callback = fb.onSnapshot.mock.calls[0]![2] as (snap: QuerySnapshot) => void
    callback(snapshot(['bad']))
    expect(onData).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledOnce()
  })
  it('accepts the exact cap and probes one extra row on both read paths', async () => {
    fb.getDocs.mockResolvedValue(snapshot(['a', 'b']))
    fb.getDocsFromServer.mockResolvedValue(snapshot(['a', 'b']))
    const list = services(true)
    expect(await list.fetch('t', 'u')).toEqual(['a', 'b'])
    expect(await list.fetchFromServer('t', 'u')).toEqual(['a', 'b'])
    expect(fb.limit.mock.calls).toEqual([[3], [3]])
  })
  it.each([['a', 'b', 'c'], ['a', 'bad']])('refuses an incomplete one-shot list %j', async (...ids) => {
    fb.getDocsFromServer.mockResolvedValue(snapshot(ids))
    await expect(services(true).fetch('t', 'u')).rejects.toThrow('無法計算完整餘額')
  })
  it('delivers a listener error rather than a partial list or an uncaught callback error', async () => {
    const onData = vi.fn()
    const onError = vi.fn()
    await services(true).subscribe('t', 'u', onData, onError)
    const callback = fb.onSnapshot.mock.calls[0]![2] as (snap: QuerySnapshot) => void
    expect(() => callback(snapshot(['a', 'bad']))).not.toThrow()
    expect(onData).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('格式異常') }))
    callback(snapshot(['a', 'b', 'c']))
    expect(onError).toHaveBeenCalledTimes(2)
    callback(snapshot(['a', 'b']))
    expect(onData).toHaveBeenCalledWith(['a', 'b'], { fromCache: false, hasPendingWrites: false })
  })
  it('keeps nonfinancial lists tolerant and their original query cap', async () => {
    fb.getDocs.mockResolvedValue(snapshot(['a', 'bad']))
    expect(await services(false).fetch('t', 'u')).toEqual(['a'])
    expect(fb.limit).toHaveBeenCalledWith(2)
  })
})

import { beforeEach, expect, it, vi } from 'vitest'
import type { QueryDocumentSnapshot, QuerySnapshot } from 'firebase/firestore'

const fb = vi.hoisted(() => ({
  db: {}, collection: vi.fn(), where: vi.fn(), orderBy: vi.fn(), limit: vi.fn(),
  query: vi.fn(), getDocs: vi.fn(), getDocsFromServer: vi.fn(), onSnapshot: vi.fn(),
}))
vi.mock('@/services/firebase', () => ({ getFirebase: async () => fb }))
vi.mock('@/services/sentry', () => ({ captureError: vi.fn() }))
vi.mock('@/services/firestoreDocFromSchema', () => ({
  firestoreDocFromSchema: (_schema: unknown, doc: QueryDocumentSnapshot) => {
    if (doc.id === 'bad') throw new Error('invalid settlement')
    return { id: doc.id }
  },
}))
import { getSettlementsByTrip, getSettlementsByTripFromServer, subscribeToSettlements, SETTLEMENT_LIST_LIMIT as LIMIT } from './settlementService'

function snapshot(size: number, invalid = false): QuerySnapshot {
  return { size, docs: Array.from({ length: size }, (_, index) => ({ id: invalid && index === 0 ? 'bad' : String(index) })), metadata: { fromCache: false, hasPendingWrites: false } } as unknown as QuerySnapshot
}
beforeEach(() => vi.clearAllMocks())

it('allows exactly the limit (500: one doc per route leg) and probes one more', async () => {
  expect(LIMIT).toBe(500)
  fb.getDocs.mockResolvedValue(snapshot(LIMIT))
  fb.getDocsFromServer.mockResolvedValue(snapshot(LIMIT))
  expect(await getSettlementsByTrip('t')).toHaveLength(LIMIT)
  expect(await getSettlementsByTripFromServer('t')).toHaveLength(LIMIT)
  expect(fb.limit.mock.calls).toEqual([[LIMIT + 1], [LIMIT + 1]])
})
it.each([[501, false], [1, true]])('refuses incomplete settlement reads (%i, %s)', async (size, invalid) => {
  fb.getDocs.mockResolvedValue(snapshot(size, invalid))
  fb.getDocsFromServer.mockResolvedValue(snapshot(size, invalid))
  await expect(getSettlementsByTrip('t')).rejects.toThrow('無法計算完整餘額')
  await expect(getSettlementsByTripFromServer('t')).rejects.toThrow('無法計算完整餘額')
})
it('applies the same strict policy to the settlement listener', async () => {
  const onData = vi.fn()
  const onError = vi.fn()
  await subscribeToSettlements('t', onData, onError)
  const callback = fb.onSnapshot.mock.calls[0]![2] as (snap: QuerySnapshot) => void
  callback(snapshot(LIMIT + 1))
  callback(snapshot(1, true))
  expect(onError).toHaveBeenCalledTimes(2)
  expect(onData).not.toHaveBeenCalled()
  expect(fb.limit).toHaveBeenCalledWith(LIMIT + 1)
})
